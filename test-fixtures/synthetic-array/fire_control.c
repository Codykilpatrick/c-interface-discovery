/*
 * fire_control.c — Acoustic fire control solution process.
 *
 * Reads AcousticSample data written by comms_bridge into shared memory,
 * computes a bearing/range solution, and transmits SolutionMsg to the
 * external weapons network over a dedicated UDP socket.
 *
 * Subscribes to MSG_TYPE_ACOUSTIC notifications via the comms pub/sub layer
 * (comms_subscribe) so that processing is triggered on new data rather than
 * by polling.  comms_subscribe is a custom IPC wrapper — register a pattern
 * for it (function: comms_subscribe, direction: recv) in the Pattern Registry
 * to have the interface graph resolve the comms_bridge → fire_control edge as
 * a confident directional arrow instead of an uncertain amber line.
 *
 * NOTE: The weapons network receiver is an external system — no source
 * for its consumer process is present in this array. MSG_TYPE_SOLUTION
 * edges in the interface graph will show as unknown consumer (? External).
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include "acoustic_types.h"
#include "sensor_defs.h"

#define WEAPONS_NET_PORT    5100
#define WEAPONS_NET_ADDR    "192.168.10.50"
#define SOLUTION_THRESHOLD  0.65f

extern int g_running;

/* Custom pub/sub wrappers — implemented in the comms layer (not in this array). */
typedef void (*comms_handler_fn)(const void *data, unsigned int len);
extern void comms_subscribe(unsigned int msg_type, comms_handler_fn handler);

static int    g_shm_id   = -1;
static void  *g_shm_ptr  = NULL;
static int    g_udp_fd   = -1;
static unsigned int g_seq = 0;

static int init_shm_reader(void)
{
    g_shm_id = shmget(SHM_KEY_ACOUSTIC, SHM_SEGMENT_SIZE, 0666);
    if (g_shm_id < 0) return -1;
    g_shm_ptr = shmat(g_shm_id, NULL, SHM_RDONLY);
    return (g_shm_ptr == (void *)-1) ? -1 : 0;
}

static int init_weapons_socket(void)
{
    struct sockaddr_in addr;

    g_udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_udp_fd < 0) return -1;

    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port   = htons(WEAPONS_NET_PORT);
    inet_aton(WEAPONS_NET_ADDR, &addr.sin_addr);

    return connect(g_udp_fd, (struct sockaddr *)&addr, sizeof(addr));
}

/*
 * Compute a bearing solution from the acoustic sample.
 * Simplified: use the bearing field directly and derive confidence
 * from amplitude vs noise floor.
 */
static int compute_solution(const AcousticSample *sample,
                            unsigned int *bearing, float *confidence)
{
    if (sample->sample_count == 0) return -1;

    *bearing    = sample->bearing;
    *confidence = sample->amplitude / 100.0f;
    if (*confidence > 1.0f) *confidence = 1.0f;

    return (*confidence >= SOLUTION_THRESHOLD) ? 0 : -1;
}

static void transmit_solution(unsigned int bearing, float confidence)
{
    SolutionMsg msg;

    msg.header.msg_type    = MSG_TYPE_SOLUTION;
    msg.header.seq_num     = g_seq++;
    msg.header.payload_len = sizeof(SolutionMsg);
    msg.header.checksum    = 0;   /* simplified — no checksum in this path */

    msg.target_bearing  = bearing;
    msg.target_range    = 0;      /* range not yet estimated */
    msg.confidence      = confidence;
    msg.solution_flags  = 0x01;   /* SOLUTION_VALID */

    /* Sent to external weapons network — no consumer in this source array */
    send(g_udp_fd, &msg, sizeof(SolutionMsg), 0);
}

static void on_acoustic(const void *data, unsigned int len)
{
    AcousticSample sample;
    unsigned int   bearing;
    float          confidence;

    if (len < sizeof(AcousticSample)) return;
    memcpy(&sample, data, sizeof(AcousticSample));

    if (compute_solution(&sample, &bearing, &confidence) == 0) {
        transmit_solution(bearing, confidence);
    }
}

int fire_control_main(void)
{
    if (init_shm_reader() != 0) {
        fprintf(stderr, "fire_control: cannot attach shm\n");
        return -1;
    }

    if (init_weapons_socket() != 0) {
        fprintf(stderr, "fire_control: cannot open weapons socket\n");
        return -1;
    }

    /*
     * Subscribe to acoustic data notifications via the comms pub/sub layer.
     * comms_subscribe is a custom send/recv wrapper — without a registered
     * pattern the tool cannot determine direction and will draw an amber
     * (uncertain) edge between this file and comms_bridge.  Add a pattern:
     *   Function: comms_subscribe   IPC type: custom   Direction: recv
     * to resolve it to a confident directional blue arrow.
     */
    comms_subscribe(MSG_TYPE_ACOUSTIC, on_acoustic);

    while (g_running) {
        usleep(1000000 / SENSOR_POLL_HZ);
    }

    shmdt(g_shm_ptr);
    close(g_udp_fd);
    return 0;
}
