#ifndef NAV_TYPES_H
#define NAV_TYPES_H

#include "cic_protocol.h"

#define NAV_GPS_FIFO     "/tmp/nav_gps.fifo"
#define NAV_FIX_PATH     "/var/nav/last.fix"
#define INS_DEV          "/dev/ins0"

typedef struct {
    DepthFix        fix;
    unsigned int    sats;
} GpsFix;

typedef GpsFix NavFixAlias;

typedef struct {
    CicHeader       hdr;
    NavFixAlias     body;
    unsigned int    source;     /* 0 = GPS, 1 = INS */
} NavFixMsg;

#endif /* NAV_TYPES_H */
