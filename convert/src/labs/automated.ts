import debug from 'debug';
import type { LabConfig } from './labConfigs.js';
import { labConfigs, labConfigsMap, parseMappingValue, toModusJsonPath } from './labConfigs.js';

const info = debug('@modusjs/convert#labs-automated:info');
const trace = debug('@modusjs/convert#labs-automated:trace');
const warn = debug('@modusjs/convert#labs-automated:warn');
const error = debug('@modusjs/convert#labs-automated:error');

// Attempt to generate a lab config based on finding matches with all existing
// lab configs. Results may vary. Some other considerations:
// - non-descript headers could lead to incorrect mappings
// - some headers include units (e.g., "Magnesium ppm Mg" so we can assume units,
//   but others are more ambiguous (e.g., "MG") and while we recognize the
//   element, we shouldn't assume units or ModusTestIds
//
export function cobbleLabConfig(headers: string[], userLabConfigs?: LabConfig[]) {
  const list = userLabConfigs || Array.from(labConfigsMap.values());
  warn(`Attempting to identify header matches individually.`);
  //1. Find modus mappings (non-analytes)
  let lcMappings = list
    .map(lc => Object.fromEntries(Object.entries(lc.mappings).map(([k, v]) => (
      [keysToUpperNoSpacesDashesOrUnderscores(k), v]
    ))))
  let mappings: LabConfig['mappings'] = {};
  headers.forEach((h) => {
    //Find potential matches
    const copy = keysToUpperNoSpacesDashesOrUnderscores(h);
    let lcMatch = lcMappings.find(lc => lc[copy])
    if (lcMatch !== undefined) mappings![h] = lcMatch[h]!;
  })
  let remaining = headers.filter(h => !mappings[h]);

  //2. Look for date column
  if (!Object.values(mappings).find(v => v === 'ReportDate')) {
    let datecol = getDateColumn(headers);
    mappings[datecol] = "ReportDate";
    remaining = remaining.filter(h => h !== datecol)
  }

  //2b. Look for lab number
  /*
  if (!Object.values(mappings).find(v => v === 'EventDate')) {
    let datecol = getLabNumberColumn(headers);
    mappings[datecol] = "EventDate";
    remaining = remaining.filter(h => h !== datecol)
  }
  */


  //3. Look for depth data columns

  //remaining = remaining.filter(h => h !== )

  let lcAnalytes = list
    .map(lc => Object.fromEntries(Object.entries(lc.analytes).map(([_, v]) => (
      [keysToUpperNoSpacesDashesOrUnderscores(v.CsvHeader || v.Element), v]
    )))).flat(1)
  let analytes: LabConfig['analytes'] = {};
  remaining.forEach((h) => {
    //Find potential matches
    const copy = keysToUpperNoSpacesDashesOrUnderscores(h);
    let lcMatch = lcAnalytes.find(lc => lc[copy])
    if (lcMatch) analytes[h] = { Element: lcMatch[h]!.Element };
  })
  remaining = remaining.filter(h => !analytes[h])

  const units = Object.fromEntries(
    Object.entries(analytes).map(([key, val]) => ([key, val?.ValueUnit]))
  );

  if (remaining.length > 0) trace(`Remaining unrecognized headers:`, remaining)

  return {
    units,
    analytes,
    headers,
    name: 'Automated',
    type: 'Automated',
    mappings,
  };
}

export function getDateColumn(headers: string[]): string {
  // Ensure we have a "date" column for this dataset
  let datecol = headers
    .sort()
    .find((name) => name.toUpperCase().match(/DATE/));
  if (headers.find((c) => c.match(/DATESUB/))) {
    trace(`Found DATESUB column, using that for date.`);
    datecol = 'DATESUB'; // A&L West Semios
    return datecol;
  } else {
    error('No date column in sheet, columns are:', headers);
    throw new Error(
      `Could not find a column containing 'date' in the name to use as the date in sheet.  A date is required.`
    );
  }
}

// Autodetect via headers being a perfect subset of a known lab.
export function autodetectLabConfig({
  headers,
  sheetname,
  labConfigs: userLabConfigs,
}: {
  headers: string[],
  sheetname?: string,
  labConfigs?: LabConfig[],
}) : LabConfig | undefined {
  let match = ((
    userLabConfigs || Array.from(labConfigsMap.values())
  ) as LabConfig[]).find((labConfig) => labMatches(headers, labConfig));
  if (match) {
    info(`Recognized sheet ${sheetname !== undefined ? `[${sheetname}] ` : '' }as lab: ${match!.name}`);
    return match;
  } else {
    warn(`No matches found while attempting to autodetect LabConfig.`);
    return undefined;
  }
}

function labMatches(headers: string[], lab: LabConfig) : boolean {
  return headers.every((header: string) => {
    if (lab.headers.indexOf(header) <= -1) {
      // If the same header appears twice in a csv, the library results in
      // <header>_<n> where n is 1,2,3...for each repeat;
      let reg = /[_\d]+$/;
      if (reg.test(header)) {
        const h = header.replace(reg, '');
        if (lab.headers.indexOf(h) > -1) return true;
      }
      trace(`Header string "${header}" not in ${lab.name} LabConfig`);
    }
    return lab.headers.indexOf(header) > -1
  })
}

export function keysToUpperNoSpacesDashesOrUnderscores(obj: any) {
  const ret: any = {};
  for (const [key, val] of Object.entries(obj)) {
    const newkey = key.toUpperCase().replace(/([ _]|-)*/g, '');
    ret[newkey] =
      typeof val === 'object'
        ? keysToUpperNoSpacesDashesOrUnderscores(val)
        : val;
  }
  return ret;
}

//
export function modusKeyToHeader(item: string, colnames: string[], labConfig?: LabConfig) : string | undefined {
  if (!labConfig) return undefined;
  let match = Object.entries(labConfig.mappings).find(([k, v]) =>
    (Array.isArray(v) ? v.some(k => k === item) : v === item) &&
    colnames.includes(k)
  );
  return match?.[0];
}

// Get a header from the labconfig
export function modusKeyToValue(row: any, item: string, labConfig?: LabConfig) {
  // Handle undefined metasheet
  if (!row) return
  // The standard CSV no longer uses the same set of headers as used in 'item' strings; it instead uses jsonpaths
  //if (item in row) return row[item]; // Handle the universal CSV
  let match = modusKeyToHeader(item, Object.keys(row), labConfig);
  if (match) {
    let mapping = toModusJsonPath[item as keyof typeof toModusJsonPath];
    return parseMappingValue(row[match], mapping);
  }
  return '';
}

function parseDepth(row: any, labConfig: LabConfig, units?: any): any {
  let obj: any = {
    DepthUnit: 'cm', //default to cm
  };

  // Get columns with the word depth
  const copy = keysToUpperNoSpacesDashesOrUnderscores(row);
  const unitsCopy = keysToUpperNoSpacesDashesOrUnderscores(units);
  let depthKey = Object.keys(copy).find((key) => key.match(/DEPTH/));
  if (depthKey) {
    let value = copy[depthKey].toString();
    if (unitsCopy[depthKey]) obj.DepthUnit = unitsCopy[depthKey];

    if (value.match(' to ')) {
      obj.StartingDepth = +value.split(' to ')[0];
      obj.EndingDepth = +value.split(' to ')[1];
      obj.Name = value;
    } else if (value.match(' - ')) {
      obj.StartingDepth = +value.split(' - ')[0];
      obj.EndingDepth = +value.split(' - ')[1];
      obj.Name = value;
    } else {
      obj.StartingDepth = +value;
      obj.Name = value;
    }
  }

  if (row['B Depth']) obj.StartingDepth = +row['B Depth'];
  if (row['B Depth']) obj.Name = '' + row['B Depth'];
  if (units['B Depth']) obj.DepthUnit = units['B Depth']; // Assume same for both top and bottom
  if (row['E Depth']) obj.EndingDepth = +row['E Depth'];

  //Insufficient data found
  if (typeof obj.StartingDepth === 'undefined') {
    warn('No depth data was found. Falling back to default depth object.');
    trace('Row without depth was: ', row);
    return {
      StartingDepth: 0,
      EndingDepth: 8,
      DepthUnit: 'in',
      Name: 'Unknown Depth',
      ColumnDepth: 8,
    };
  }

  //Handle single depth value
  obj.EndingDepth = obj.EndingDepth || obj.StartingDepth;

  //Now compute column depth
  obj.ColumnDepth = Math.abs(obj.EndingDepth - obj.StartingDepth);

  return obj;
}