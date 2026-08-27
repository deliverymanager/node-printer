#if defined(DMKIOSK_NODE_PRINTER_RELEASE_BUILD)

#if !defined(_WIN32) || !defined(_M_X64)
#error "DM KIOSK node-printer releases require Windows AMD64"
#endif

#include "node_printer_release_marker.generated.h"

#if !defined(DMKIOSK_NODE_PRINTER_RELEASE_MARKER)
#error "DM KIOSK node-printer release marker is missing"
#endif

extern "C" __declspec(dllexport) const char
    DMKIOSK_NODE_PRINTER_RELEASE_PROVENANCE[] =
        DMKIOSK_NODE_PRINTER_RELEASE_MARKER;

#endif
