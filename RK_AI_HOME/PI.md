# RK AI Home (Pi) - Backend Integration

This backend powers RK AI Home (Raspberry Pi). All endpoints below are used exclusively or primarily by the Pi.

---

## Pi Endpoints

### Audio / STT
- **POST /audio/:slug** - Transcribe base64-encoded audio using Whisper
- **GET /audio/:slug** - Health check for audio endpoint

### Device State
- **GET /device/:slug/status** - Get device status, storage info, last seen
- **POST /device/:slug/state** - Update device busy state ("thinking", "speaking", etc.)
- **POST /device/:slug/update-status** - Update busy and download progress status
- **POST /device/:slug/settings** - Update device settings (assistant name, wake words, TTS config, night mode)

### STT Logs
- **POST /device/:slug/stt-log** - Add new STT log entry
- **GET /device/:slug/stt-log** - Get recent STT logs (last 50)

### Alarms & Schedules
- **GET /device/:slug/alarms** - Get all alarms
- **GET /device/:slug/schedules** - Get all schedules
- **POST /device/:slug/sync_alarms** - Sync alarms from Pi to Appwrite DB
- **POST /device/:slug/sync_schedules** - Sync schedules from Pi to Appwrite DB

### Maintenance & Polling
- **GET /device/:slug/maintenance** - Pi polls this every 60 seconds for background tasks:
  - Updates last seen
  - Refreshes daily limits
  - Cleans up old files
- **GET /device/:slug/commands/pending** - Poll for pending commands (from frontend/web)

### Command Execution
- **POST /device/:slug/commands/:command_id/complete** - Mark a queued command as completed/failed with result

### Music
- **POST /device/:slug/music/recommend** - Get next song recommendation based on current one

### Device Management
- **POST /device/ensure/:slug** - Ensure device exists in Appwrite (create if needed)
- **GET /device/check/:slug** - Check if device with slug exists
- **POST /device/:slug/verify** - Verify device password
- **POST /device/:slug/mute** - Toggle device mute state
- **POST /device/:slug/memory** - Toggle memory (chat history) enabled state
- **POST /device/:slug/trial** - Start 7-day free trial

### Files
- **GET /device/:slug/files** - List generated files (images/videos/docs)
- **GET /device/:slug/file/:filename** - Download file
- **DELETE /device/:slug/file/:filename** - Delete file

### Text & AI
- **POST /text/:slug** - Process text input via intent classification and AI
- **GET /chat/:slug** - Load chat history
- **DELETE /chat/:slug/:index** - Delete chat history entry
- **GET /limits/:slug** - Get daily usage limits
- **GET /ai/models** - List available Gemini models

---

## Architecture
- Pi polls `/device/:slug/commands/pending` every ~10-30 seconds for new commands
- Commands are stored in Appwrite `commands` collection with `status: pending`
- Pi executes commands and marks them complete via `/complete` endpoint
- Maintenance endpoint is polled every 60 seconds
