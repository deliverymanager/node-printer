#include <cassert>
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

typedef uint32_t DWORD;
typedef int BOOL;
typedef void* HANDLE;
typedef void* LPVOID;
typedef unsigned char* LPBYTE;
struct DOC_INFO_1W {};

static std::string failedStage;
static DWORD lastError;
static DWORD written;
static bool abortFails;
static std::vector<std::string> calls;

static BOOL call(const char* stage)
{
    calls.push_back(stage);
    if (failedStage == stage) { lastError = 123; return 0; }
    return 1;
}
static DWORD GetLastError() { return lastError; }
static DWORD StartDocPrinterW(HANDLE, DWORD, LPBYTE) { return call("StartDocPrinterW") ? 42 : 0; }
static BOOL StartPagePrinter(HANDLE) { return call("StartPagePrinter"); }
static BOOL WritePrinter(HANDLE, LPVOID, DWORD, DWORD* count)
{
    *count = written;
    return call("WritePrinter");
}
static BOOL EndPagePrinter(HANDLE) { return call("EndPagePrinter"); }
static BOOL EndDocPrinter(HANDLE) { return call("EndDocPrinter"); }
static BOOL AbortPrinter(HANDLE)
{
    calls.push_back("AbortPrinter");
    lastError = 999; // Cleanup must not replace the original Windows error.
    return abortFails ? 0 : 1;
}

#include "../src/print_job_win.hpp"

static PrintJobResult run(const char* failure = "", DWORD bytes = 4, bool abortFailure = false,
    std::size_t requested = 4)
{
    failedStage = failure;
    written = bytes;
    abortFails = abortFailure;
    lastError = 777; // Successful APIs need not clear an earlier error.
    calls.clear();
    DOC_INFO_1W document;
    return submitPrintJob(NULL, document, "data", requested);
}

int main()
{
    unsigned tests = 0;
    PrintJobResult result = run();
    assert(result.success() && result.jobId == 42 && result.bytesWritten == 4);
    assert(!result.abortAttempted);
    assert((calls == std::vector<std::string>{"StartDocPrinterW", "StartPagePrinter", "WritePrinter", "EndPagePrinter", "EndDocPrinter"}));
    ++tests;

    const char* stages[] = {"StartDocPrinterW", "StartPagePrinter", "WritePrinter", "EndPagePrinter", "EndDocPrinter"};
    for (unsigned i = 0; i < 5; ++i)
    {
        result = run(stages[i]);
        assert(!result.success() && std::string(result.stage) == stages[i]);
        assert(result.win32Code == 123);
        assert(result.jobId == (i == 0 ? 0u : 42u));
        assert(result.abortAttempted == (i != 0));
        assert(result.deliveryUncertain == (i >= 2));
        assert(calls.size() == i + 1 + (i == 0 ? 0 : 1));
        if (i != 0) assert(calls.back() == "AbortPrinter");
        ++tests;
    }

    result = run("WritePrinter", 0);
    assert(!result.success() && result.bytesWritten == 0 && result.win32Code == 123);
    ++tests;
    result = run("", 2);
    assert(!result.success() && std::string(result.code) == "ERR_PRINT_SHORT_WRITE");
    assert(result.win32Code == 0 && result.bytesWritten == 2);
    assert((calls == std::vector<std::string>{"StartDocPrinterW", "StartPagePrinter", "WritePrinter", "AbortPrinter"}));
    ++tests;

    result = run("EndDocPrinter", 4, true);
    assert(result.win32Code == 123 && result.abortAttempted && !result.abortSucceeded);
    assert(result.abortWin32Code == 999 && result.jobId == 42);
    assert(printJobErrorMessage(result).find("win32Code=123, jobId=42, bytesWritten=4, bytesRequested=4") != std::string::npos);
    ++tests;

    result = run("", 0, false, 0);
    assert(result.success() && result.bytesRequested == 0 && result.bytesWritten == 0);
    ++tests;
    std::size_t oversized = (std::numeric_limits<DWORD>::max)();
    if (++oversized != 0)
    {
        result = run("", 0, false, oversized);
        assert(!result.success() && std::string(result.code) == "ERR_PRINT_DATA_TOO_LARGE");
        assert(calls.empty() && !result.abortAttempted);
        ++tests;
    }

    calls.clear();
    result = failPrintJob(PrintJobResult(4), NULL, "OpenPrinterW", 5);
    assert(!result.success() && result.jobId == 0 && result.win32Code == 5);
    assert(calls.empty() && !result.abortAttempted);
    ++tests;
    std::cout << "PASS " << tests << " Windows print-job fault-injection cases (no printer access)\n";
}
