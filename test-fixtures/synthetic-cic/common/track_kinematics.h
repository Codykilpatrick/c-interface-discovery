#ifndef CIC_TRACK_KINEMATICS_H
#define CIC_TRACK_KINEMATICS_H

#include "motion.h"

/* Layer 5 — nested by FusedContact. */
typedef struct {
    MotionState     motion;
    int             vx;
    int             vy;
    float           snr;
} TrackKinematics;

#endif
