/*
 * hydra_sensor.c — HYDRA acoustic sensor process.
 *
 * Reads raw samples from the sonar hardware, packages them into AcousticMsg,
 * and sends to the COMMS bridge over a TCP socket. Also sends StatusMsg on
 * state changes and AlarmMsg on fault conditions.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "acoustic_types.h"
#include "sensor_defs.h"

extern int       g_running;
extern SensorState g_sensor_state;

static int       g_sock_fd = -1;
static unsigned int g_seq  = 0;

static unsigned char compute_checksum(const void *data, unsigned int len)
{
    const unsigned char *p = (const unsigned char *)data;
    unsigned char sum = 0;
    unsigned int i;
    for (i = 0; i < len; i++) sum ^= p[i];
    return sum;
}

static int connect_to_comms(void)
{
    struct sockaddr_in addr;

    g_sock_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_sock_fd < 0) return -1;

    addr.sin_family = AF_INET;
    addr.sin_port   = htons(COMMS_BRIDGE_PORT);
    inet_aton(COMMS_BRIDGE_ADDR, &addr.sin_addr);

    return connect(g_sock_fd, (struct sockaddr *)&addr, sizeof(addr));
}

static void send_status(SensorStatus status, const char *text)
{
    StatusMsg msg;

    msg.header.msg_type    = MSG_TYPE_STATUS;
    msg.header.seq_num     = g_seq++;
    msg.header.payload_len = sizeof(StatusMsg);
    msg.sensor_id          = g_sensor_state.config.sensor_id;
    msg.status_flags       = (unsigned int)status;

    /* NOTE: strcpy used here — legacy code, sensor_defs guarantees text < 64 */
    strcpy(msg.status_text, text);

    msg.header.checksum = compute_checksum(&msg, sizeof(StatusMsg));
    send(g_sock_fd, &msg, sizeof(StatusMsg), 0);
}

static void send_alarm(unsigned int code, unsigned int severity, const char *desc)
{
    AlarmMsg msg;

    msg.header.msg_type    = MSG_TYPE_ALARM;
    msg.header.seq_num     = g_seq++;
    msg.header.payload_len = sizeof(AlarmMsg);
    msg.alarm_code         = code;
    msg.severity           = severity;

    snprintf(msg.description, sizeof(msg.description), "%s", desc);

    msg.header.checksum = compute_checksum(&msg, sizeof(AlarmMsg));
    send(g_sock_fd, &msg, sizeof(AlarmMsg), 0);
}

static int read_and_send_sample(void)
{
    AcousticMsg msg;
    AcousticSample *s = &msg.sample;

    /* Read raw data from sonar hardware driver */
    if (sonar_hw_read(g_sensor_state.config.device_path, s) != 0) {
        send_alarm(0x10, 2, "sonar_hw_read failed");
        return -1;
    }

    msg.header.msg_type    = MSG_TYPE_ACOUSTIC;
    msg.header.seq_num     = g_seq++;
    msg.header.payload_len = sizeof(AcousticMsg);
    msg.header.checksum    = compute_checksum(&msg, sizeof(AcousticMsg));

    if (send(g_sock_fd, &msg, sizeof(AcousticMsg), 0) < 0) {
        send_alarm(0x11, 3, "socket send failed");
        return -1;
    }
    return 0;
}

static void send_heartbeat(void)
{
    MsgHeader hb;
    hb.msg_type    = MSG_TYPE_HEARTBEAT;
    hb.seq_num     = g_seq++;
    hb.payload_len = sizeof(MsgHeader);
    hb.checksum    = compute_checksum(&hb, sizeof(MsgHeader));
    send(g_sock_fd, &hb, sizeof(MsgHeader), 0);
}

int sensor_main(SensorConfig *cfg)
{
    int tick = 0;

    g_sensor_state.config = *cfg;

    if (connect_to_comms() != 0) {
        fprintf(stderr, "Failed to connect to COMMS bridge\n");
        return -1;
    }

    send_status(SENSOR_INIT, "sensor initializing");

    if (sonar_hw_init(cfg->device_path, cfg->sample_rate, cfg->gain) != 0) {
        send_alarm(0x01, 3, "hardware init failed");
        send_status(SENSOR_OFFLINE, "init failure");
        return -1;
    }

    send_status(SENSOR_OK, "sensor ready");

    while (g_running) {
        if (read_and_send_sample() != 0 && tick % MAX_RETRY_COUNT == 0) {
            send_status(SENSOR_ERROR, "repeated read failures");
        }
        if (tick % HEARTBEAT_INTERVAL == 0) {
            send_heartbeat();
        }
        tick++;
        usleep(1000000 / SENSOR_POLL_HZ);
    }

    send_status(SENSOR_OFFLINE, "sensor shutting down");
    close(g_sock_fd);
    return 0;
}
