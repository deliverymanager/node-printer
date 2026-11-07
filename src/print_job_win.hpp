#ifndef NODE_PRINTER_PRINT_JOB_WIN_HPP
#define NODE_PRINTER_PRINT_JOB_WIN_HPP

#include <cstddef>
#include <limits>
#include <sstream>
#include <string>

// Include after the Winspool declarations. The same submission code is exercised
// with fake Win32 calls by the portable fault-injection test; it never prints.
struct PrintJobResult
{
    PrintJobResult(std::size_t requested)
        : stage(NULL), code(NULL), win32Code(0), jobId(0),
          bytesRequested(requested), bytesWritten(0), deliveryUncertain(false),
          abortAttempted(false), abortSucceeded(false), abortWin32Code(0) {}

    bool success() const { return stage == NULL; }
    const char* stage;
    const char* code;
    DWORD win32Code;
    DWORD jobId;
    std::size_t bytesRequested;
    DWORD bytesWritten;
    bool deliveryUncertain;
    bool abortAttempted;
    bool abortSucceeded;
    DWORD abortWin32Code;
};

inline PrintJobResult failPrintJob(PrintJobResult result, HANDLE printer,
    const char* stage, DWORD errorCode, const char* code = "ERR_WIN32_PRINT")
{
    // The caller captures GetLastError before cleanup can overwrite it.
    result.stage = stage;
    result.code = code;
    result.win32Code = errorCode;
    if (result.jobId != 0)
    {
        result.abortAttempted = true;
        result.abortSucceeded = AbortPrinter(printer) != 0;
        if (!result.abortSucceeded)
        {
            result.abortWin32Code = GetLastError();
        }
    }
    return result;
}

inline PrintJobResult submitPrintJob(HANDLE printer, DOC_INFO_1W& document,
    const char* data, std::size_t size)
{
    PrintJobResult result(size);
    if (size > (std::numeric_limits<DWORD>::max)())
    {
        return failPrintJob(result, printer, "WritePrinter", 0,
            "ERR_PRINT_DATA_TOO_LARGE");
    }

    result.jobId = StartDocPrinterW(printer, 1, (LPBYTE)&document);
    if (result.jobId == 0)
    {
        return failPrintJob(result, printer, "StartDocPrinterW", GetLastError());
    }
    if (!StartPagePrinter(printer))
    {
        return failPrintJob(result, printer, "StartPagePrinter", GetLastError());
    }

    // AbortPrinter cannot undo bytes a device has already consumed. A failure
    // after entering WritePrinter must not be interpreted as safe to replay.
    result.deliveryUncertain = true;
    if (!WritePrinter(printer, (LPVOID)data, (DWORD)size, &result.bytesWritten))
    {
        return failPrintJob(result, printer, "WritePrinter", GetLastError());
    }
    if (result.bytesWritten != size)
    {
        // WritePrinter returned success, so GetLastError would be stale here.
        return failPrintJob(result, printer, "WritePrinter", 0,
            "ERR_PRINT_SHORT_WRITE");
    }
    if (!EndPagePrinter(printer))
    {
        return failPrintJob(result, printer, "EndPagePrinter", GetLastError());
    }
    if (!EndDocPrinter(printer))
    {
        return failPrintJob(result, printer, "EndDocPrinter", GetLastError());
    }
    return result;
}

inline std::string printJobErrorMessage(const PrintJobResult& result)
{
    std::ostringstream message;
    message << result.stage << " failed (code=" << result.code
        << ", win32Code=" << result.win32Code << ", jobId=" << result.jobId
        << ", bytesWritten=" << result.bytesWritten
        << ", bytesRequested=" << result.bytesRequested << ")";
    return message.str();
}

#endif
