/*
 * slemr_types.h — Types and constants for the SLEMR custom IPC bus.
 *
 * SLEMR (Submarine Legacy Embedded Message Router) is a proprietary
 * message-passing layer that wraps socket transport. Messages are sent
 * via slemr_send_message(handle, msg_id, size, data) where msg_id is
 * a runtime constant defined below.
 *
 * This fixture tests Strategy A (constant-argument extraction) and
 * Strategy B (wrapper function parameter analysis).
 */

#ifndef SLEMR_TYPES_H
#define SLEMR_TYPES_H

/* ── SLEMR message IDs — non-standard naming (no MSG_TYPE_ prefix) ─── */
#define SLEMR_MSG_SONAR_PING      0x10
#define SLEMR_MSG_TARGET_TRACK    0x11
#define SLEMR_MSG_WEAPONS_RELEASE 0x12
#define SLEMR_MSG_HEARTBEAT       0x13
#define SLEMR_MISSING_HEADER_MSG  0xFF  /* intentionally left undefined in consumer */

/* ── SLEMR handle — opaque to callers ──────────────────────────────── */
typedef struct slemr_handle_s * slemr_handle_t;

/* ── Message structs ────────────────────────────────────────────────── */
typedef struct {
    unsigned int    bearing;        /* degrees 0-359 */
    unsigned int    range_meters;
    float           confidence;
    unsigned int    seq;
} SonarPingData;

typedef struct {
    unsigned int    track_id;
    int             x_pos;
    int             y_pos;
    int             x_vel;
    int             y_vel;
    unsigned int    quality;
} TargetTrackData;

typedef struct {
    unsigned int    weapon_id;
    unsigned int    target_track_id;
    unsigned int    fire_solution_flags;
    float           bearing;
    float           range;
} WeaponsReleaseData;

/* ── SLEMR API ──────────────────────────────────────────────────────── */
int  slemr_send_message(slemr_handle_t handle, unsigned int msg_id,
                        unsigned int size, const void *data);
int  slemr_recv_message(slemr_handle_t handle, unsigned int *msg_id_out,
                        unsigned int *size_out, void *data);
slemr_handle_t slemr_connect(const char *endpoint);
void slemr_disconnect(slemr_handle_t handle);

#endif /* SLEMR_TYPES_H */
