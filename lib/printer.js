const path = require('path');

// Try to load the native addon from the packaged location first.
// Fallback to the local build output when developing from source.
let binding;

try {
  binding = require(path.join(__dirname, 'node_printer.node'));
} catch (e) {
  binding = require(path.join(__dirname, '..', 'build', 'Release', 'node_printer.node'));
}

function wrapPrintDirect(native) {
  return function printDirect() {
    // Object-style API: printDirect(options)
    if (arguments.length === 1 && typeof arguments[0] === 'object' && arguments[0] !== null) {
      const opts = arguments[0];
      const data = opts.data;
      const printer = opts.printer || opts.printername || opts.printerName || native.getDefaultPrinterName();
      const docname = opts.docname || opts.docName || 'Node.js Printer';
      const type = opts.type || 'RAW';
      const printOptions = opts.options || {};
      const success = typeof opts.success === 'function' ? opts.success : null;
      const error = typeof opts.error === 'function' ? opts.error : null;

      try {
        const jobId = native.printDirect(data, printer, docname, type, printOptions);
        if (success) {
          success(jobId);
        }
        return jobId;
      } catch (err) {
        if (error) {
          error(err);
          return;
        }
        throw err;
      }
    }

    // Legacy positional API: printDirect(data, printer, docname, type, options)
    return native.printDirect.apply(native, arguments);
  };
}

function wrapPrintFile(native) {
  return function printFile() {
    // Object-style API: printFile(options)
    if (arguments.length === 1 && typeof arguments[0] === 'object' && arguments[0] !== null) {
      const opts = arguments[0];
      const filename = opts.filename;
      const printer = opts.printer || opts.printername || opts.printerName || native.getDefaultPrinterName();
      const docname = opts.docname || opts.docName || filename || 'Node.js Printer';
      const printOptions = opts.options || {};
      const success = typeof opts.success === 'function' ? opts.success : null;
      const error = typeof opts.error === 'function' ? opts.error : null;

      try {
        const jobId = native.printFile(filename, docname, printer, printOptions);
        if (success) {
          success(jobId);
        }
        return jobId;
      } catch (err) {
        if (error) {
          error(err);
          return;
        }
        throw err;
      }
    }

    // Legacy positional API: printFile(filename, docname, printer, options)
    return native.printFile.apply(native, arguments);
  };
}

module.exports = {
  // native exports
  getPrinters: binding.getPrinters,
  getDefaultPrinterName: binding.getDefaultPrinterName,
  getPrinter: binding.getPrinter,
  getPrinterDriverOptions: binding.getPrinterDriverOptions,
  getJob: binding.getJob,
  setJob: binding.setJob,
  getSupportedPrintFormats: binding.getSupportedPrintFormats,
  getSupportedJobCommands: binding.getSupportedJobCommands,
  // wrapped functions
  printDirect: wrapPrintDirect(binding),
  printFile: wrapPrintFile(binding)
};
