/*
 * cic_types.h — CIC-local track record.
 *
 * TrackMsg here adds fusion fields on top of the protocol TrackMsg, so
 * loading cic/ plus common/ flags a struct conflict.
 */

#ifndef CIC_TYPES_H
#define CIC_TYPES_H

#include "cic_protocol.h"
#include "cic_bus.h"

#define CIC_AUTH_PIPE    "/tmp/cic_auth.pipe"
#define CIC_WATCHDOG_BIN "/usr/local/bin/cic-watchdog"

typedef struct {
    CicHeader       hdr;
    unsigned int    track_id;
    TrackKinematics kin;
    unsigned int    source;
    unsigned int    source_flags;
    unsigned int    age_sec;
} TrackMsg;

typedef struct {
    unsigned int    count;
    TrackMsg        tracks[CIC_MAX_TRACKS];
} PictureTable;

#endif /* CIC_TYPES_H */
