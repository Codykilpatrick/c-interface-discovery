/*
 * solution_receiver.c — Ingests fire control solutions from the sensor array.
 *
 * Listens on WCS_SOLUTION_PORT (UDP) for MSG_TYPE_SOLUTION messages sent by
 * fire_control in the acoustic sensor array.  Solutions that exceed the lock
 * confidence threshold are packaged as MSG_TYPE_TARGET_LOCK and forwarded to
 * target_tracker via the internal WCS message queue (WCS_MQ_KEY).
 *
 * Cross-application data flow:
 *   [sensor array / fire_control] --MSG_TYPE_SOLUTION--> [WCS / solution_receiver]
 *
 * Internal data flow:
 *   [solution_receiver] --MSG_TYPE_TARGET_LOCK--> [target_tracker]  (via mqueue)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/msg.h>
#include <sys/ipc.h>
#include <netinet/in.h>
#include "wcs_types.h"

extern int g_wcs_running;

static int           g_udp_fd  = -1;
static int           g_mq_id   = -1;
static unsigned int  g_track_id = 0;

typedef struct {
    long           mtype;
    TargetLockMsg  payload;
} MqTargetLock;

static int init_solution_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_udp_fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (g_udp_fd < 0) return -1;

    setsockopt(g_udp_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(WCS_SOLUTION_PORT);

    if (bind(g_udp_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return 0;
}

static int init_internal_queue(void)
{
    g_mq_id = msgget(WCS_MQ_KEY, IPC_CREAT | 0666);
    return (g_mq_id < 0) ? -1 : 0;
}

static void forward_as_target_lock(const SolutionMsg *sol)
{
    MqTargetLock mqmsg;
    TargetLockMsg *lock = &mqmsg.payload;

    mqmsg.mtype = MSG_TYPE_TARGET_LOCK;

    lock->header.msg_type    = MSG_TYPE_TARGET_LOCK;
    lock->header.seq_num     = g_track_id;
    lock->header.payload_len = sizeof(TargetLockMsg);
    lock->header.checksum    = 0;

    lock->track_id   = ++g_track_id;
    lock->bearing    = sol->target_bearing;
    lock->range      = sol->target_range;
    lock->confidence = sol->confidence;
    lock->lock_flags = (sol->confidence >= LOCK_CONFIDENCE_MIN)
                       ? 0x01   /* LOCK_CONFIRMED */
                       : 0x00;

    if (msgsnd(g_mq_id, &mqmsg, sizeof(TargetLockMsg), 0) < 0) {
        perror("solution_receiver: msgsnd target_lock");
    }
}

static void process_solution(const unsigned char *buf, unsigned int len)
{
    const MsgHeader   *hdr;
    const SolutionMsg *sol;

    if (len < sizeof(MsgHeader)) return;
    hdr = (const MsgHeader *)buf;

    if (hdr->msg_type != MSG_TYPE_SOLUTION) {
        fprintf(stderr, "solution_receiver: unexpected msg_type 0x%02x\n",
                hdr->msg_type);
        return;
    }

    if (len < sizeof(SolutionMsg)) return;
    sol = (const SolutionMsg *)buf;

    fprintf(stderr, "solution_receiver: bearing=%u range=%u confidence=%.2f\n",
            sol->target_bearing, sol->target_range, sol->confidence);

    if (sol->confidence < 0.10f) {
        fprintf(stderr, "solution_receiver: confidence too low, discarding\n");
        return;
    }

    forward_as_target_lock(sol);
}

int solution_receiver_main(void)
{
    unsigned char buf[MAX_PAYLOAD_LEN];
    struct sockaddr_in src;
    socklen_t src_len = sizeof(src);
    int n;

    if (init_solution_listener() != 0) {
        perror("solution_receiver: bind");
        return -1;
    }

    if (init_internal_queue() != 0) {
        perror("solution_receiver: msgget");
        return -1;
    }

    fprintf(stderr, "solution_receiver: listening on port %d\n", WCS_SOLUTION_PORT);

    while (g_wcs_running) {
        n = recvfrom(g_udp_fd, buf, sizeof(buf), 0,
                     (struct sockaddr *)&src, &src_len);
        if (n < 0) continue;

        process_solution(buf, (unsigned int)n);
    }

    close(g_udp_fd);
    return 0;
}
