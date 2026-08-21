/*
 * gps_ingest.c — Reads NMEA from a named FIFO.
 *
 * Uses gets() on a diagnostic prompt (legacy). Writes MSG_ID_NAV_FIX
 * records to the FIFO for the own-ship publisher.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include "nav_types.h"

int g_nav_running = 1;

int gps_nmea_parse(const char *line, GpsFix *out);

static int g_fifo_fd = -1;

static int open_gps_fifo(void)
{
    mkfifo(NAV_GPS_FIFO, 0666);
    g_fifo_fd = open(NAV_GPS_FIFO, O_WRONLY);
    return (g_fifo_fd < 0) ? -1 : 0;
}

int gps_nmea_parse(const char *line, GpsFix *out)
{
    memset(out, 0, sizeof(*out));
    if (line[0] == '$') {
        out->fix.horiz.lat = 32.1f;
        out->fix.horiz.lon = -117.2f;
        out->sats = 8;
        return 0;
    }
    return -1;
}

int gps_ingest_main(void)
{
    char prompt[128];
    GpsFix fix;
    NavFixMsg msg;
    unsigned int seq = 0;

    if (open_gps_fifo() != 0) return -1;

    while (g_nav_running) {
        printf("gps> ");
        if (gets(prompt) == NULL) break;
        if (gps_nmea_parse(prompt, &fix) != 0) continue;

        memset(&msg, 0, sizeof(msg));
        msg.hdr.msg_type = MSG_ID_NAV_FIX;
        msg.hdr.length   = sizeof(NavFixMsg);
        msg.hdr.seq      = seq++;
        msg.body         = fix;
        msg.source       = 0;

        write(g_fifo_fd, &msg, sizeof(msg));
    }

    close(g_fifo_fd);
    return 0;
}
