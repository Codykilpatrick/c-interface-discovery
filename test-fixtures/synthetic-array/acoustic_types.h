/*
 * acoustic_types.h — Message types and structs for the acoustic sensor array.
 * Shared by all processes in this array.
 */

#ifndef ACOUSTIC_TYPES_H
#define ACOUSTIC_TYPES_H

#define MSG_TYPE_ACOUSTIC    0x01
#define MSG_TYPE_STATUS      0x02
#define MSG_TYPE_COMMAND     0x03
#define MSG_TYPE_ALARM       0x04
#define MSG_TYPE_HEARTBEAT   0x05

#define MAX_PAYLOAD_LEN      512
#define MAX_SAMPLE_POINTS    256

typedef struct {
    unsigned int    msg_type;
    unsigned int    seq_num;
    unsigned int    payload_len;
    unsigned char   checksum;
} MsgHeader;

typedef struct {
    float           frequency;
    float           amplitude;
    unsigned int    bearing;        /* degrees, 0-359 */
    unsigned int    sample_count;
    short           samples[MAX_SAMPLE_POINTS];
} AcousticSample;

typedef struct {
    MsgHeader       header;
    AcousticSample  sample;
} AcousticMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    sensor_id;
    unsigned int    status_flags;
    char            status_text[64];
} StatusMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    command_id;
    unsigned int    param1;
    unsigned int    param2;
} CommandMsg;

typedef struct {
    MsgHeader       header;
    unsigned int    alarm_code;
    unsigned int    severity;
    char            description[128];
} AlarmMsg;

typedef enum {
    SENSOR_OK      = 0,
    SENSOR_ERROR   = 1,
    SENSOR_OFFLINE = 2,
    SENSOR_INIT    = 3
} SensorStatus;

#endif /* ACOUSTIC_TYPES_H */
