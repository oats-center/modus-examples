import type * as libs from '../../browser/index.js';
import debug from 'debug';
import chalk from 'chalk';

import xmlTests from '../xml.test.js';
import csvTests from '../csv.test.js';
import toCsvTests from '../toCsv.test.js';
import toJsonTests from '../tojson.test.js';
import htmlTests from './html.test.js';
import fileTests from './file.test.js';
import unitsTests from '../units.test.js';

const info = debug('@modusjs/convert#test-browser:info');

// Set your browser debugging level in localStorage.debug
localStorage.debug = '*';

type WindowWithLibs = {
  libsundertest: typeof libs;
};

document.addEventListener('DOMContentLoaded', async () => {
  try {
    const libsundertest = (window as unknown as WindowWithLibs).libsundertest;
    const root = document.getElementById('root');
    if (!root) throw new Error('ERROR: did not find root HTML element!');
    root.innerHTML =
      'Tests from <pre>dist/test/index.mjs are running!  Check the console.';

    // Run all the tests you want here:
    info('testing xml');
    await xmlTests(libsundertest);

    info('testing CSV');
    await csvTests(libsundertest);

    info('testing toCsv');
    await toCsvTests(libsundertest);

    info('testing toJson');
    await toJsonTests(libsundertest);

    info('testing browser HTML');
    await htmlTests(libsundertest);

    info('testing browser file');
    await fileTests(libsundertest);

    info('testing browser units');
    await unitsTests(libsundertest);
  } catch (e: any) {
    info(chalk.red('FAILED: tests threw exception: '));
    console.log(e);
    throw e; // rethrow so browser will show stack and do source mapping
  }
});
