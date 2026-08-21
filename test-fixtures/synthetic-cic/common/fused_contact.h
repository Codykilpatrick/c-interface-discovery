#ifndef CIC_FUSED_CONTACT_H
#define CIC_FUSED_CONTACT_H

#include "track_kinematics.h"

/* Layer 6 — nested by ContactMsg in cic_protocol.h. */
typedef struct {
    TrackKinematics kin;
    unsigned int    sensor_id;
    char            label[32];
} FusedContact;

#endif
