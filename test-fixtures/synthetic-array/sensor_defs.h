/*
 * sensor_defs.h — Configuration constants for the acoustic sensor array.
 */

#ifndef SENSOR_DEFS_H
#define SENSOR_DEFS_H

/* Network — COMMS bridge endpoint */
#define COMMS_BRIDGE_PORT   5000
#define COMMS_BRIDGE_ADDR   "127.0.0.1"

/* Shared memory */
#define SHM_KEY_ACOUSTIC    0x4143
#define SHM_KEY_STATUS      0x5354
#define SHM_SEGMENT_SIZE    4096

/* Sensor timing */
#define SENSOR_POLL_HZ      50
#define HEARTBEAT_INTERVAL  10

#ifdef DEBUG
#define MAX_RETRY_COUNT     10
#define LOG_LEVEL           3
#define ENABLE_TRACE        1
#else
#define MAX_RETRY_COUNT     3
#define LOG_LEVEL           1
#endif

typedef struct {
    unsigned int    sensor_id;
    unsigned int    sample_rate;
    float           gain;
    unsigned int    flags;
    char            device_path[64];
} SensorConfig;

typedef struct {
    unsigned int    seq;
    unsigned int    timestamp;
    SensorConfig    config;
} SensorState;

/* Cross-process supervisor API — implemented in signal_handler.c */
void supervisor_send_reload(void);

#endif /* SENSOR_DEFS_H */
