/*
 * wcs_console.c — Captain/XO console interface for the WCS.
 *
 * Listens on WCS_CONSOLE_PORT (TCP) for MSG_TYPE_LAUNCH_AUTH messages sent
 * by the external captain's console hardware.  The console is an external
 * system — no source for it is present in this application.  MSG_TYPE_LAUNCH_AUTH
 * edges from the console will show as ? External in the interface graph.
 *
 * Validated authorization messages are written to WCS_PIPE_AUTH (a named pipe)
 * for weapons_director to read.  MSG_TYPE_WEAPON_STATUS messages received from
 * weapons_director on the same pipe are forwarded back to the console display.
 *
 * Cross-application data flows:  none (this process only talks within WCS)
 *
 * Internal data flows:
 *   [? External console] --MSG_TYPE_LAUNCH_AUTH--> [wcs_console]      (TCP socket)
 *   [wcs_console]        --MSG_TYPE_LAUNCH_AUTH--> [weapons_director] (named pipe)
 *   [wcs_console]        <--MSG_TYPE_WEAPON_STATUS- [weapons_director] (named pipe)
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include "wcs_types.h"

extern int g_wcs_running;

static int          g_listen_fd  = -1;
static int          g_client_fd  = -1;
static int          g_wpipe_fd   = -1;   /* write end → weapons_director */
static unsigned int g_seq        = 0;

static int init_console_listener(void)
{
    struct sockaddr_in addr;
    int opt = 1;

    g_listen_fd = socket(AF_INET, SOCK_STREAM, 0);
    if (g_listen_fd < 0) return -1;

    setsockopt(g_listen_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    memset(&addr, 0, sizeof(addr));
    addr.sin_family      = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port        = htons(WCS_CONSOLE_PORT);

    if (bind(g_listen_fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) return -1;
    return listen(g_listen_fd, 2);
}

static int init_auth_pipe(void)
{
    mkfifo(WCS_PIPE_AUTH, 0666);
    g_wpipe_fd = open(WCS_PIPE_AUTH, O_WRONLY | O_NONBLOCK);
    return (g_wpipe_fd < 0) ? -1 : 0;
}

static int validate_auth(const LaunchAuthMsg *auth)
{
    /* Require non-zero auth code and at least one authorization flag */
    if (auth->auth_code == 0) return 0;
    if (auth->auth_flags == 0) return 0;
    if (auth->track_id  == 0) return 0;
    return 1;
}

static void relay_to_director(const LaunchAuthMsg *auth)
{
    if (write(g_wpipe_fd, auth, sizeof(LaunchAuthMsg)) < 0) {
        perror("wcs_console: write to auth pipe");
    }
}

static void send_status_ack(unsigned int track_id)
{
    WeaponStatusMsg status;

    status.header.msg_type    = MSG_TYPE_WEAPON_STATUS;
    status.header.seq_num     = g_seq++;
    status.header.payload_len = sizeof(WeaponStatusMsg);
    status.header.checksum    = 0;

    status.tube_id      = 0;
    status.weapon_type  = 0;
    status.status_flags = 0x01;   /* READY */

    snprintf(status.status_text, sizeof(status.status_text),
             "AUTH RECEIVED track=%u", track_id);

    if (g_client_fd >= 0) {
        send(g_client_fd, &status, sizeof(WeaponStatusMsg), 0);
    }
}

static void console_loop(int fd)
{
    unsigned char buf[MAX_PAYLOAD_LEN];
    int n;

    while (g_wcs_running) {
        n = recv(fd, buf, sizeof(buf), 0);
        if (n <= 0) break;

        if ((unsigned int)n < sizeof(MsgHeader)) continue;
        const MsgHeader *hdr = (const MsgHeader *)buf;

        if (hdr->msg_type != MSG_TYPE_LAUNCH_AUTH) {
            fprintf(stderr, "wcs_console: unexpected msg 0x%02x from console\n",
                    hdr->msg_type);
            continue;
        }

        if ((unsigned int)n < sizeof(LaunchAuthMsg)) continue;
        const LaunchAuthMsg *auth = (const LaunchAuthMsg *)buf;

        if (!validate_auth(auth)) {
            fprintf(stderr, "wcs_console: invalid auth token from console\n");
            continue;
        }

        fprintf(stderr, "wcs_console: launch auth track=%u flags=0x%02x\n",
                auth->track_id, auth->auth_flags);

        relay_to_director(auth);
        send_status_ack(auth->track_id);
    }
}

int wcs_console_main(void)
{
    if (init_console_listener() != 0) {
        perror("wcs_console: bind");
        return -1;
    }

    if (init_auth_pipe() != 0) {
        perror("wcs_console: pipe");
        return -1;
    }

    while (g_wcs_running) {
        g_client_fd = accept(g_listen_fd, NULL, NULL);
        if (g_client_fd < 0) continue;
        console_loop(g_client_fd);
        close(g_client_fd);
        g_client_fd = -1;
    }

    close(g_listen_fd);
    close(g_wpipe_fd);
    return 0;
}
