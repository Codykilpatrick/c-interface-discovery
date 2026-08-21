#ifndef CIC_GEO_COORD_H
#define CIC_GEO_COORD_H

#include "time_stamp.h"

/* Layer 2 — nested by DepthFix. */
typedef struct {
    CicTime         when;
    float           lat;
    float           lon;
} GeoCoord;

#endif
