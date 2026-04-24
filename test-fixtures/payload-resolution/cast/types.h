/* Ground truth: RadarMsg is the payload struct (strategy: cast, confidence: medium) */
#define MSG_RADAR 0x20

typedef struct {
    float range_m;
    float bearing_deg;
    unsigned int target_id;
} RadarMsg;
