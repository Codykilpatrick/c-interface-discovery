/*
 * config_loader.c — Reads sensor configuration from flat file.
 *
 * Parses the sensor config file at startup and on SIGHUP reload.
 * Writes the resulting SensorConfig into shared memory so all
 * processes in the array can access current config.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/shm.h>
#include <sys/ipc.h>
#include "acoustic_types.h"
#include "sensor_defs.h"

#define CONFIG_PATH     "/etc/hydra/sensor.conf"
#define CONFIG_LINE_MAX 256

extern SensorState g_sensor_state;

static int parse_line(const char *line, SensorConfig *cfg)
{
    char key[64], val[128];

    if (sscanf(line, "%63s = %127s", key, val) != 2) return 0;

    if (strcmp(key, "sensor_id")   == 0) { cfg->sensor_id   = (unsigned int)atoi(val); return 1; }
    if (strcmp(key, "sample_rate") == 0) { cfg->sample_rate = (unsigned int)atoi(val); return 1; }
    if (strcmp(key, "gain")        == 0) { cfg->gain        = (float)atof(val);        return 1; }
    if (strcmp(key, "device")      == 0) { strcpy(cfg->device_path, val);               return 1; }

    return 0;
}

SensorConfig config_load(void)
{
    SensorConfig cfg;
    char line[CONFIG_LINE_MAX];
    FILE *f;

    memset(&cfg, 0, sizeof(cfg));
    cfg.sample_rate = SENSOR_POLL_HZ;  /* default */

    f = fopen(CONFIG_PATH, "r");
    if (!f) {
        fprintf(stderr, "config_loader: cannot open %s\n", CONFIG_PATH);
        return cfg;
    }

    while (fgets(line, sizeof(line), f)) {
        if (line[0] == '#' || line[0] == '\n') continue;
        parse_line(line, &cfg);
    }

    fclose(f);
    return cfg;
}

int config_write_shm(const SensorConfig *cfg)
{
    int shm_id;
    void *ptr;

    shm_id = shmget(SHM_KEY_STATUS, sizeof(SensorConfig), IPC_CREAT | 0666);
    if (shm_id < 0) return -1;

    ptr = shmat(shm_id, NULL, 0);
    if (ptr == (void *)-1) return -1;

    memcpy(ptr, cfg, sizeof(SensorConfig));
    shmdt(ptr);
    return 0;
}
