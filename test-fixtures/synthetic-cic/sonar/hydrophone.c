/*
 * hydrophone.c — Sonar front-end.
 *
 * Reads the hydrophone via ioctl, copies the beam label with strcpy,
 * and writes the latest frame into sonar shared memory for the beamformer.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/ioctl.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include "sonar_types.h"

int g_sonar_running = 1;

static int   g_hw_fd  = -1;
static int   g_shm_id = -1;
static SonarFrame *g_frame = NULL;

static int init_hw(void)
{
    g_hw_fd = open(SONAR_DEV_PATH, O_RDWR);
    if (g_hw_fd < 0) return -1;
    return sonar_hw_ioctl_gain(g_hw_fd, 80);
}

static int init_shm(void)
{
    g_shm_id = shmget(SONAR_SHM_KEY, SONAR_SHM_SIZE, IPC_CREAT | 0666);
    if (g_shm_id < 0) return -1;
    g_frame = (SonarFrame *)shmat(g_shm_id, NULL, 0);
    return (g_frame == (void *)-1) ? -1 : 0;
}

int sonar_hw_ioctl_gain(int fd, int gain)
{
    return ioctl(fd, SONAR_IOCTL_GAIN, &gain);
}

int sonar_hw_init(const char *path)
{
    (void)path;
    return 0;
}

int sonar_hw_read(int fd, BeamBuffer *out)
{
    memset(out, 0, sizeof(*out));
    out->beam_id = 1;
    out->n_samples = 64;
    out->peak = 12.0f;
    return ioctl(fd, SONAR_IOCTL_BEAM, out);
}

static void store_frame(const BeamBuffer *beam)
{
    char name[48];
    char label[8];

    g_frame->n_beams = 1;
    g_frame->beams[0] = *beam;
    g_frame->stamp.ts_ms = 0;
    g_frame->stamp.flags = PLATFORM_STAMP_VALID;

    sprintf(name, "beam-%u", beam->beam_id);
    strcpy(label, name);
}

int hydrophone_main(void)
{
    BeamBuffer beam;

    if (sonar_hw_init(SONAR_DEV_PATH) != 0) return -1;
    if (init_hw() != 0) return -1;
    if (init_shm() != 0) return -1;

    while (g_sonar_running) {
        if (sonar_hw_read(g_hw_fd, &beam) == 0)
            store_frame(&beam);
        usleep(20000);
    }

    shmdt(g_frame);
    close(g_hw_fd);
    return 0;
}
