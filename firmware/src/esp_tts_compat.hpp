#pragma once

// ESP-SR v1.2.0's public C header uses the C++ keyword `template` as a
// parameter name and closes its extern block incorrectly. Keep the ABI exact
// while exposing only the declarations used by this firmware.
extern "C" {

typedef struct {
  char* voice_name;
  char* format;
  int sample_rate;
  int bit_width;
  int syll_num;
  char** sylls;
  int* syll_pos;
  short* pinyin_idx;
  short* phrase_dict;
  short* extern_idx;
  short* extern_dict;
  unsigned char* data;
} esp_tts_voice_t;

typedef void* esp_tts_handle_t;

extern const esp_tts_voice_t esp_tts_voice_template;

esp_tts_voice_t* esp_tts_voice_set_init(
    const esp_tts_voice_t* voice_template,
    void* data);
void esp_tts_voice_set_free(esp_tts_voice_t* voice);
esp_tts_handle_t esp_tts_create(esp_tts_voice_t* voice);
int esp_tts_parse_chinese(esp_tts_handle_t tts_handle, const char* text);
short* esp_tts_stream_play(
    esp_tts_handle_t tts_handle,
    int* length,
    unsigned int speed);
void esp_tts_stream_reset(esp_tts_handle_t tts_handle);
void esp_tts_destroy(esp_tts_handle_t tts_handle);

}  // extern "C"
