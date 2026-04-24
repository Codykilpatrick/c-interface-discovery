/* Ground truth: AcousticMsg is the payload struct (strategy: pointer, confidence: high) */
#define MSG_ACOUSTIC 0x10

typedef struct {
    unsigned short freq_hz;
    unsigned short amplitude;
    unsigned int duration_ms;
} AcousticMsg;
