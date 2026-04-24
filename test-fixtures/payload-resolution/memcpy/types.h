/* Ground truth: SonarMsg is the payload struct (strategy: memcpy, confidence: medium) */
#define MSG_SONAR 0x30

typedef struct {
    float depth_m;
    float bearing_deg;
    unsigned short ping_count;
} SonarMsg;
