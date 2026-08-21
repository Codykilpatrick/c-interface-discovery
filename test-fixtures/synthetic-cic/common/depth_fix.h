#ifndef CIC_DEPTH_FIX_H
#define CIC_DEPTH_FIX_H

#include "geo_coord.h"

/* Layer 3 — nested by MotionState via DepthFixAlias. */
typedef struct {
    GeoCoord        horiz;
    float           depth;
} DepthFix;

typedef DepthFix DepthFixAlias;

#endif
