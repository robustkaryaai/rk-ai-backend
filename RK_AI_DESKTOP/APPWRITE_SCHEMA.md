
# RK AI: Appwrite Collection Schema
---

## 📊 Devices Collection (Existing, Used by Both Home & Desktop)
### 🆕 New Column to Add:
| Column Name | Type | Default |
|-------------|------|---------|
| `device_type` | String | "home" |

### Existing Columns (Do Not Change!):
| Column Name | Type |
|-------------|------|
| `slug` | Integer (Unique) |
| `subscription` | String ("true"/"false") |
| `subscription-tier` | Integer (0, 1, 2) |
| `name_of_device` | String |
| `storage_limit_mb` | Integer |
| `storageUsing` | String ("supabase"/"google") |

---

## 📋 Usage Notes
- **RK AI Home Devices**: `device_type` = "home"
- **RK AI Desktop Devices**: `device_type` = "desktop"

That's it! No new collections needed! Just add one column!
