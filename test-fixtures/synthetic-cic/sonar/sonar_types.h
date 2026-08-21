#ifndef SONAR_TYPES_H
#define SONAR_TYPES_H

#include "cic_protocol.h"
#include "platform.h"

#define SONAR_IOCTL_GAIN      0x5301
#define SONAR_IOCTL_BEAM      0x5302
#define SONAR_DEV_PATH        "/dev/sonar0"
#define SONAR_SHM_KEY         0x534E
#define SONAR_SHM_SIZE        4096
#define SONAR_MAX_BEAMS       16

typedef struct {
    unsigned int    beam_id;
    short           samples[256];
    unsigned int    n_samples;
    float           peak;
} BeamBuffer;

typedef struct {
    PlatformStamp   stamp;
    BeamBuffer      beams[SONAR_MAX_BEAMS];
    unsigned int    n_beams;
} SonarFrame;

/* Sonar-local wrapper — one more nest on top of the 6-layer FusedContact. */
typedef struct {
    FusedContact    fused;
    unsigned int    beam_id;
    float           peak;
} SonarContact;

int  sonar_hw_init(const char *path);
int  sonar_hw_read(int fd, BeamBuffer *out);
int  sonar_hw_ioctl_gain(int fd, int gain);

#endif /* SONAR_TYPES_H */
