#ifndef FC_TYPES_H
#define FC_TYPES_H

#include "cic_protocol.h"
#include "cic_bus.h"

#define FC_MAX_TRACKS    16

/*
 * Fire-control local wrap of the 6-layer kinematics. AimSolution sits on
 * TrackKinematics, which already nests MotionState → DepthFix → GeoCoord → CicTime.
 */
typedef struct {
    TrackKinematics kin;
    unsigned int    tube_id;
    float           time_to_impact;
} AimSolution;

typedef struct {
    EngageMsg       order;
    AimSolution     aim;
} FireDirective;

#endif /* FC_TYPES_H */
