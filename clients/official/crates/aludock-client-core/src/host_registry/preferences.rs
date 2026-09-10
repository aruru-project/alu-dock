use std::{fs, path::PathBuf, time::Duration};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{ensure_root_directory, read_private_json, sync_directory, write_new_private_file};
use crate::{ClientError, Result};

const PREFERENCES_SCHEMA_VERSION: u32 = 1;
const SNAPSHOT_PREFIX: &str = "preferences-";
const SNAPSHOT_SUFFIX: &str = ".json";

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowsAwayDelay {
    Immediate,
    #[default]
    OneMinute,
    FiveMinutes,
    ThirtyMinutes,
    OneHour,
    Never,
}

impl WindowsAwayDelay {
    pub fn duration(self) -> Option<Duration> {
        match self {
            Self::Immediate => Some(Duration::ZERO),
            Self::OneMinute => Some(Duration::from_secs(60)),
            Self::FiveMinutes => Some(Duration::from_secs(5 * 60)),
            Self::ThirtyMinutes => Some(Duration::from_secs(30 * 60)),
            Self::OneHour => Some(Duration::from_secs(60 * 60)),
            Self::Never => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientPreferences {
    pub schema_version: u32,
    pub revision: u64,
    pub windows_away_delay: WindowsAwayDelay,
    #[serde(default = "default_start_local_host")]
    pub windows_start_local_host: bool,
}

fn default_start_local_host() -> bool {
    true
}

impl ClientPreferences {
    fn initial() -> Self {
        Self {
            schema_version: PREFERENCES_SCHEMA_VERSION,
            revision: 1,
            windows_away_delay: WindowsAwayDelay::default(),
            windows_start_local_host: true,
        }
    }

    fn validate(&self) -> Result<()> {
        if self.schema_version != PREFERENCES_SCHEMA_VERSION || self.revision == 0 {
            return Err(ClientError::InvalidPairing(
                "stored client preferences schema or revision is invalid".into(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
pub struct ClientPreferencesStore {
    root: PathBuf,
}

impl ClientPreferencesStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self> {
        let store = Self { root: root.into() };
        ensure_root_directory(&store.root)?;
        if store.load_snapshot()?.is_none() {
            store.write_snapshot(&ClientPreferences::initial())?;
        }
        store.snapshot()?;
        Ok(store)
    }

    pub fn snapshot(&self) -> Result<ClientPreferences> {
        self.load_snapshot()?.ok_or_else(|| {
            ClientError::InvalidPairing("client preferences have no committed snapshot".into())
        })
    }

    pub fn update_windows_away_delay(
        &self,
        expected_revision: u64,
        delay: WindowsAwayDelay,
    ) -> Result<ClientPreferences> {
        self.update(expected_revision, |snapshot| {
            snapshot.windows_away_delay = delay
        })
    }

    pub fn update_windows_start_local_host(
        &self,
        expected_revision: u64,
        enabled: bool,
    ) -> Result<ClientPreferences> {
        self.update(expected_revision, |snapshot| {
            snapshot.windows_start_local_host = enabled
        })
    }

    fn update(
        &self,
        expected_revision: u64,
        change: impl FnOnce(&mut ClientPreferences),
    ) -> Result<ClientPreferences> {
        let mut snapshot = self.snapshot()?;
        if snapshot.revision != expected_revision {
            return Err(ClientError::PreferencesConflict {
                expected: expected_revision,
                actual: snapshot.revision,
            });
        }
        snapshot.revision = snapshot.revision.checked_add(1).ok_or_else(|| {
            ClientError::InvalidPairing("client preferences revision overflowed".into())
        })?;
        change(&mut snapshot);
        snapshot.validate()?;
        if !self.write_snapshot(&snapshot)? {
            let actual = self.snapshot()?.revision;
            return Err(ClientError::PreferencesConflict {
                expected: expected_revision,
                actual,
            });
        }
        self.cleanup_snapshots(snapshot.revision)?;
        Ok(snapshot)
    }

    fn load_snapshot(&self) -> Result<Option<ClientPreferences>> {
        let mut files = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let revision = parse_snapshot_filename(&name).ok_or_else(|| {
                ClientError::InvalidPairing(
                    "client preferences contain an unexpected committed entry".into(),
                )
            })?;
            files.push((revision, entry.path()));
        }
        files.sort_by_key(|item| item.0);
        let Some((filename_revision, path)) = files.last() else {
            return Ok(None);
        };
        let snapshot: ClientPreferences = read_private_json(path)?;
        snapshot.validate()?;
        if snapshot.revision != *filename_revision {
            return Err(ClientError::InvalidPairing(
                "client preferences filename and revision do not match".into(),
            ));
        }
        Ok(Some(snapshot))
    }

    fn write_snapshot(&self, snapshot: &ClientPreferences) -> Result<bool> {
        let final_path = self.root.join(snapshot_filename(snapshot.revision));
        let temporary = self.root.join(format!(".{}.tmp", Uuid::new_v4()));
        write_new_private_file(&temporary, &serde_json::to_vec_pretty(snapshot)?)?;
        match crate::fs_publish::publish_new_file(&temporary, &final_path) {
            Ok(true) => {
                sync_directory(&self.root)?;
                Ok(true)
            }
            Ok(false) => Ok(false),
            Err(source) => Err(ClientError::Storage {
                path: final_path.display().to_string(),
                source,
            }),
        }
    }

    fn cleanup_snapshots(&self, latest_revision: u64) -> Result<()> {
        let retain_from = latest_revision.saturating_sub(1);
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if parse_snapshot_filename(&name).is_some_and(|revision| revision < retain_from) {
                fs::remove_file(entry.path())?;
            }
        }
        sync_directory(&self.root)
    }
}

fn snapshot_filename(revision: u64) -> String {
    format!("{SNAPSHOT_PREFIX}{revision:020}{SNAPSHOT_SUFFIX}")
}

fn parse_snapshot_filename(name: &str) -> Option<u64> {
    name.strip_prefix(SNAPSHOT_PREFIX)?
        .strip_suffix(SNAPSHOT_SUFFIX)?
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_choices_are_kept_after_reopening() {
        let root =
            std::env::temp_dir().join(format!("aludock-client-preferences-{}", Uuid::new_v4()));
        let store = ClientPreferencesStore::open(&root).unwrap();
        let initial = store.snapshot().unwrap();
        assert_eq!(initial.windows_away_delay, WindowsAwayDelay::OneMinute);
        assert!(initial.windows_start_local_host);
        let pure_client = store
            .update_windows_start_local_host(initial.revision, false)
            .unwrap();

        store
            .update_windows_away_delay(pure_client.revision, WindowsAwayDelay::ThirtyMinutes)
            .unwrap();
        drop(store);

        let reopened = ClientPreferencesStore::open(&root).unwrap();
        assert!(!reopened.snapshot().unwrap().windows_start_local_host);
        assert_eq!(
            reopened.snapshot().unwrap().windows_away_delay,
            WindowsAwayDelay::ThirtyMinutes
        );
        fs::remove_dir_all(root).unwrap();
    }
}
