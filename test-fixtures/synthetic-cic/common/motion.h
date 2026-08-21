#ifndef CIC_MOTION_H
#define CIC_MOTION_H

#include "depth_fix.h"

/* Layer 4 — nested by TrackKinematics. */
typedef struct {
    DepthFixAlias   pos;
    float           heading;
    float           speed_kt;
} MotionState;

#endif
