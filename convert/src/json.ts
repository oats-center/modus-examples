// Functions to auto-detect types and convert a batch of files into an array of Modus JSON's,
// with suggested output filenames.  Just give each input file a filename whose extension
// reflects its type, and
import debug from 'debug';
import jszip from 'jszip';
import Slim, { assert as assertSlim }  from '@oada/types/modus/slim/v1/0.js';
import ModusResult, { assert as assertModusResult } from '@oada/types/modus/v1/modus-result.js';
/*
import ModusResult, {
  assert as assertModusResult,
} from '@oada/types/modus/v1/modus-result.js';
*/
import pointer from 'json-pointer';
import { supportedFormats, SupportedFormats } from './fromCsvToModusV1.js';
import { parseCsv as csvParse } from './csv.js';
import { parseModusResult as xmlParseModusResult } from './xml.js';
import type { NutrientResult } from '@modusjs/units';
import type { LabConfig } from './labs/index.js';
import { fromModusV1 } from './slim.js';

export * as slim from './slim.js'

const error = debug('@modusjs/convert#tojson:error');
const warn = debug('@modusjs/convert#tojson:error');
const info = debug('@modusjs/convert#tojson:info');
const trace = debug('@modusjs/convert#tojson:trace');

export type SupportedFileType = 'xml' | 'csv' | 'xlsx' | 'json' | 'zip';
export const supportedFileTypes = ['xml', 'csv', 'xlsx', 'json', 'zip'];

export { Slim };
export { ModusResult, assertModusResult };

export type ModusJSONConversionResult = {
  original_filename: string;
  original_type: SupportedFileType;
  output_filename: string;
  modus: Slim;
};

export type InputFile = {
  filename: string; // can include the path on the front
  format?: 'generic'; // only for CSV/XLSX files, default generic (same as generic for now)
  str?: string;
  // zip or xlsx can either be ArrayBuffer or base64 string of original file.
  // Do not use for other types, they should all just be strings.
  arrbuf?: ArrayBuffer;
  base64?: string;
};

// This function will attempt to convert all the input files into an array of Modus JSON files
export async function toJson(
  files: InputFile[] | InputFile,
  labConfigs?: LabConfig[],
): Promise<ModusJSONConversionResult[]> {
  if (!Array.isArray(files)) {
    files = [files];
  }
  let results: ModusJSONConversionResult[] = [];
  for (const file of files) {
    const format = file.format || 'generic';
    let original_type = typeFromFilename(file.filename);
    if (!original_type) {
      warn('WARNING: unable to determine file type from filename',file.filename,'.  Supported types are:',supportedFileTypes,'.  Skipping file.');
      continue;
    }

    if (original_type === 'csv' || original_type === 'xlsx') {
      if (!supportedFormats.find((f) => f === format)) {
        warn('ERROR: format', format, 'is not supported for file',file.filename,'.  Supported formats are: ',supportedFormats,'.  Skipping file.');
        continue;
      }
    }
    switch (original_type) {
      case 'xlsx':
      case 'zip':
        if (!file.arrbuf && !file.base64) {
          warn('Type of',file.filename,'was',original_type,'but that must be an ArrayBuffer or Base64 encoded string.  Skipping.');
          continue;
        }
        break;
      case 'csv':
      case 'xml':
      case 'json':
        if (!file.str) {
          warn('CSV, XML, and JSON input files must be strings, but file',file.filename,'is not.');
          continue;
        }
    }
    const base = { original_filename: file.filename, original_type };
    const type = original_type; // just to make things shorter later in json filename determination
    const filename = file.filename;
    let output_filename = '';
    let modus: Slim | any | null = null;
    try {
      switch (original_type) {
        case 'zip':
          const zip_modus = await zipParse(file);
          results = [...results, ...zip_modus];
          break;
        case 'json':
          modus = typeof file.str! === 'string' ? JSON.parse(file.str!) : file.str!;
          if (modus._type === 'application/vnd.modus.v1.modus-result+json' || modus.Events) {
            modus = fromModusV1(modus);
          }
          assertSlim(modus); // catch below will inform if parsing or assertion failed.
          output_filename = jsonFilenameFromOriginalFilename({
            modus,
            type,
            filename,
          });
          results.push({ modus, output_filename, ...base }); // just one Modus in this case
          break;
        case 'xml':
          modus = xmlParseModusResult(file.str!);
          output_filename = jsonFilenameFromOriginalFilename({
            modus,
            type,
            filename,
          });
          if (modus) {
            if (modus._type === 'application/vnd.modus.v1.modus-result+json' || modus.Events) {
              modus = fromModusV1(modus);
            }
            results.push({ modus, output_filename, ...base }); // just one
          }
          break;
        case 'csv':
        case 'xlsx':
          let parseargs;
          if (original_type === 'csv') parseargs = { str: file.str, format, filename };
          else {
            if (file.arrbuf)
              parseargs = {
                arrbuf: file.arrbuf,
                format,
                filename,
              };
            // checked for at least one of these above
            else parseargs = { base64: file.base64, format, filename };
          }
          const all_modus = csvParse({...parseargs, labConfigs});
          for (const [index, modus] of all_modus.entries()) {
            const filename_args: FilenameArgs = { modus, type, filename };
            if (all_modus.length > 1) {
              // multiple things, then use the index
              filename_args.index = index;
            }
            output_filename = jsonFilenameFromOriginalFilename(filename_args);
            results.push({ modus, output_filename, ...base });
          }
          break;
      }
    } catch (e: any) {
      if (e.errors && e.input && Array.isArray(e.errors)) {
        // AJV error
        warn('ERROR: failed to validate file', file.filename);
        for (const ajv_error of e.errors) {
          warn('Path', ajv_error.instancePath, ajv_error.message); // '/path/to/item' 'must be an array'
        }
      } else {
        warn('ERROR: failed to read file', file.filename);
        console.log(e);
      }
      continue; // if error, move on to the next file
    }
  } // end for loop on filenames
  return results;
}

// If index is defined, it will name the file with the index
// If type is csv or xlsx, it will try to grab the FileDescription from the report to include the sheetname as part of the filename
export type FilenameArgs = {
  modus: Slim;
  index?: number;
  filename: string;
  type: SupportedFileType;
};
export function jsonFilenameFromOriginalFilename({
  modus,
  index,
  filename,
  type,
}: FilenameArgs): string {
  const output_filename_base = filename.replace(
    /\.(xml|csv|xlsx|zip)$/,
    '.json'
  );
  let output_filename = output_filename_base;
  // xslx and csv store the sheetname + group number in FileDescription, we can name things by that
  const filedescription = pointer.has(modus, '/lab/files/0/description') ? pointer.get(modus, '/lab/files/0/description') : '';
  if (
    (type === 'xlsx' || type === 'csv' || type === 'zip') &&
    filedescription
  ) {
    output_filename = output_filename.replace(
      /\.json$/,
      `${filedescription.replace(/[^a-zA-Z0-9_\\-]*/g, '')}.json`
    );
  } else {
    if (typeof index !== 'undefined') {
      // more than one result, have to number the output files
      output_filename = output_filename.replace(/\.json$/, `_${index}.json`);
    }
  }
  return output_filename;
}

export function typeFromFilename(filename: string): SupportedFileType | null {
  if (filename.match(/\.xml$/)) return 'xml';
  if (filename.match(/\.csv$/)) return 'csv';
  if (filename.match(/\.xlsx$/)) return 'xlsx';
  if (filename.match(/.json$/)) return 'json';
  if (filename.match(/.zip/)) return 'zip';
  return null;
}


// I moved all the Zip file stuff to json.ts because json.ts and zip.ts were a circular dependency, and
// nothing but json.ts actually imported the zip.ts stuff.

export type ZipFile = {
  filename: string;
  arrbuf?: ArrayBuffer;
  base64?: string;
  format?: SupportedFormats;
};

export async function zipParse(file: ZipFile) {
  let opts = {};
  const data = file.arrbuf || file.base64;
  if (file.base64) {
    opts = { base64: true };
  }
  if (!data) {
    error(
      'ERROR: Zip input file had neither arrbuf nor base64.  At least one is required.'
    );
    throw new Error(
      'Zip must have either array buffer or base64-encoded string'
    );
  }

  const zip = await jszip.loadAsync(data, opts);
  let all_convert_inputs = [];
  for (const zf of Object.values(zip.files)) {
    if (zf.dir) continue;
    const type = typeFromFilename(zf.name);
    // Strip all path info from the filename:
    const filename = zf.name.replace(/^(.*[\/\\])*/g, '');
    trace('Found file', filename, 'of type', type, 'in zip');
    let convert_input: InputFile = { filename, format: file.format };
    switch (type) {
      case 'zip':
      case 'xlsx':
        convert_input.arrbuf = await zf.async('arraybuffer');
        break;
      case 'xml':
      case 'csv':
      case 'json':
        convert_input.str = await zf.async('string');
        break;
    }
    all_convert_inputs.push(convert_input);
  }
  return toJson(all_convert_inputs);
}