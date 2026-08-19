use std::{
    ffi::{OsStr, c_void},
    io,
    mem::{size_of, zeroed},
    os::windows::ffi::OsStrExt,
    path::Path,
    ptr::{null, null_mut},
};

use windows_sys::Win32::{
    Foundation::{
        CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, INVALID_HANDLE_VALUE,
        LocalFree,
    },
    Security::{
        ACCESS_ALLOWED_ACE, ACL, ACL_SIZE_INFORMATION, AclSizeInformation,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            GetSecurityInfo, SDDL_REVISION_1, SE_FILE_OBJECT, SetSecurityInfo,
        },
        CONTAINER_INHERIT_ACE, DACL_SECURITY_INFORMATION, GetAce, GetAclInformation,
        GetSecurityDescriptorControl, GetSecurityDescriptorDacl, GetSecurityDescriptorOwner,
        GetTokenInformation, OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION,
        PROTECTED_DACL_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, SE_DACL_PROTECTED, TOKEN_QUERY,
        TOKEN_USER, TokenUser,
    },
    Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle, OPEN_EXISTING, READ_CONTROL,
        WRITE_DAC, WRITE_OWNER,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
const SYSTEM_SID: &str = "S-1-5-18";

pub(crate) fn secure_directory(path: &Path) -> io::Result<()> {
    apply_private_acl(path, true)
}

pub(crate) fn secure_file(path: &Path) -> io::Result<()> {
    apply_private_acl(path, false)
}

pub(crate) fn assert_private_directory(path: &Path) -> io::Result<()> {
    let handle = open_security_handle(path, true, false)?;
    assert_private_acl(&handle, true)
}

pub(crate) fn assert_private_file(path: &Path) -> io::Result<()> {
    let handle = open_security_handle(path, false, false)?;
    assert_private_acl(&handle, false)
}

fn apply_private_acl(path: &Path, directory: bool) -> io::Result<()> {
    let user_sid = current_user_sid_string()?;
    let mut handle = open_security_handle(path, directory, false)?;
    let replace_owner = owner_sid_string(&handle)? != user_sid;
    if replace_owner {
        drop(handle);
        handle = open_security_handle(path, directory, true)?;
    }

    let inheritance = if directory { "OICI" } else { "" };
    let descriptor =
        format!("O:{user_sid}D:P(A;{inheritance};FA;;;SY)(A;{inheritance};FA;;;{user_sid})");
    let descriptor_wide = wide_null(OsStr::new(&descriptor));

    unsafe {
        let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();
        if ConvertStringSecurityDescriptorToSecurityDescriptorW(
            descriptor_wide.as_ptr(),
            SDDL_REVISION_1,
            &mut security_descriptor,
            null_mut(),
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let security_descriptor = LocalAllocation(security_descriptor);
        let mut dacl_present = 0;
        let mut dacl_defaulted = 0;
        let mut dacl: *mut ACL = null_mut();
        if GetSecurityDescriptorDacl(
            security_descriptor.0,
            &mut dacl_present,
            &mut dacl,
            &mut dacl_defaulted,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        if dacl_present == 0 || dacl.is_null() {
            return Err(invalid_acl("generated security descriptor has no DACL"));
        }

        let mut owner = null_mut();
        let mut owner_defaulted = 0;
        if GetSecurityDescriptorOwner(security_descriptor.0, &mut owner, &mut owner_defaulted) == 0
        {
            return Err(io::Error::last_os_error());
        }
        if owner.is_null() {
            return Err(invalid_acl("generated security descriptor has no owner"));
        }

        let security_information = DACL_SECURITY_INFORMATION
            | PROTECTED_DACL_SECURITY_INFORMATION
            | if replace_owner {
                OWNER_SECURITY_INFORMATION
            } else {
                0
            };
        let status = SetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            security_information,
            if replace_owner { owner } else { null_mut() },
            null_mut(),
            dacl,
            null(),
        );
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
    }

    assert_private_acl(&handle, directory)
}

fn assert_private_acl(handle: &OwnedHandle, directory: bool) -> io::Result<()> {
    let expected_user = current_user_sid_string()?;

    unsafe {
        let mut owner = null_mut();
        let mut dacl: *mut ACL = null_mut();
        let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut security_descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let security_descriptor = LocalAllocation(security_descriptor);
        if owner.is_null() || sid_to_string(owner)? != expected_user {
            return Err(invalid_acl("private object has an unexpected owner"));
        }
        if dacl.is_null() {
            return Err(invalid_acl("private object has no DACL"));
        }

        let mut control = 0;
        let mut revision = 0;
        if GetSecurityDescriptorControl(security_descriptor.0, &mut control, &mut revision) == 0 {
            return Err(io::Error::last_os_error());
        }
        if control & SE_DACL_PROTECTED == 0 {
            return Err(invalid_acl("private object inherits access permissions"));
        }

        let mut information: ACL_SIZE_INFORMATION = zeroed();
        if GetAclInformation(
            dacl,
            &mut information as *mut _ as *mut c_void,
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        if information.AceCount != 2 {
            return Err(invalid_acl("private object has unexpected access entries"));
        }

        let expected_flags = if directory {
            (OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE) as u8
        } else {
            0
        };
        let mut saw_user = false;
        let mut saw_system = false;
        for index in 0..information.AceCount {
            let mut raw_ace: *mut c_void = null_mut();
            if GetAce(dacl, index, &mut raw_ace) == 0 {
                return Err(io::Error::last_os_error());
            }
            let header = &*(raw_ace as *const windows_sys::Win32::Security::ACE_HEADER);
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE || header.AceFlags != expected_flags {
                return Err(invalid_acl("private object has an unsafe access entry"));
            }
            let ace = &*(raw_ace as *const ACCESS_ALLOWED_ACE);
            if ace.Mask != FILE_ALL_ACCESS {
                return Err(invalid_acl("private object has an unsafe access mask"));
            }
            let sid = sid_to_string(&ace.SidStart as *const u32 as *mut c_void)?;
            if sid == expected_user && !saw_user {
                saw_user = true;
            } else if sid == SYSTEM_SID && !saw_system {
                saw_system = true;
            } else {
                return Err(invalid_acl(
                    "private object grants access to an unexpected identity",
                ));
            }
        }
        if !saw_user || !saw_system {
            return Err(invalid_acl(
                "private object is missing a required access entry",
            ));
        }
    }
    Ok(())
}

fn owner_sid_string(handle: &OwnedHandle) -> io::Result<String> {
    unsafe {
        let mut owner = null_mut();
        let mut security_descriptor: PSECURITY_DESCRIPTOR = null_mut();
        let status = GetSecurityInfo(
            handle.0,
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            null_mut(),
            null_mut(),
            &mut security_descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let _security_descriptor = LocalAllocation(security_descriptor);
        if owner.is_null() {
            return Err(invalid_acl("private object has no owner"));
        }
        sid_to_string(owner)
    }
}

fn open_security_handle(
    path: &Path,
    directory: bool,
    write_owner: bool,
) -> io::Result<OwnedHandle> {
    let path_wide = wide_path(path)?;
    let desired_access = READ_CONTROL | WRITE_DAC | if write_owner { WRITE_OWNER } else { 0 };
    let flags = FILE_FLAG_OPEN_REPARSE_POINT
        | if directory {
            FILE_FLAG_BACKUP_SEMANTICS
        } else {
            0
        };
    unsafe {
        let handle = CreateFileW(
            path_wide.as_ptr(),
            desired_access,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            flags,
            null_mut(),
        );
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let handle = OwnedHandle(handle);
        let mut information: BY_HANDLE_FILE_INFORMATION = zeroed();
        if GetFileInformationByHandle(handle.0, &mut information) == 0 {
            return Err(io::Error::last_os_error());
        }
        let attributes = information.dwFileAttributes;
        if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(invalid_acl("private path must not be a reparse point"));
        }
        let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if is_directory != directory {
            return Err(invalid_acl("private path has an unexpected object type"));
        }
        Ok(handle)
    }
}

fn current_user_sid_string() -> io::Result<String> {
    unsafe {
        let mut token: HANDLE = null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return Err(io::Error::last_os_error());
        }
        let token = OwnedHandle(token);
        let mut length = 0;
        GetTokenInformation(token.0, TokenUser, null_mut(), 0, &mut length);
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_INSUFFICIENT_BUFFER as i32) || length == 0 {
            return Err(error);
        }
        let word_size = size_of::<usize>();
        let mut buffer = vec![0usize; (length as usize).div_ceil(word_size)];
        if GetTokenInformation(
            token.0,
            TokenUser,
            buffer.as_mut_ptr() as *mut c_void,
            length,
            &mut length,
        ) == 0
        {
            return Err(io::Error::last_os_error());
        }
        let token_user = &*(buffer.as_ptr() as *const TOKEN_USER);
        sid_to_string(token_user.User.Sid)
    }
}

unsafe fn sid_to_string(sid: *mut c_void) -> io::Result<String> {
    let mut value = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut value) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let value = LocalAllocation(value as PSECURITY_DESCRIPTOR);
    let mut length = 0;
    while unsafe { *(value.0 as *const u16).add(length) } != 0 {
        length += 1;
    }
    Ok(String::from_utf16_lossy(unsafe {
        std::slice::from_raw_parts(value.0 as *const u16, length)
    }))
}

fn wide_path(path: &Path) -> io::Result<Vec<u16>> {
    let absolute = std::path::absolute(path)?;
    let mut value: Vec<u16> = absolute.as_os_str().encode_wide().collect();
    for unit in &mut value {
        if *unit == b'/' as u16 {
            *unit = b'\\' as u16;
        }
    }

    const SEPARATOR: u16 = b'\\' as u16;
    const QUESTION: u16 = b'?' as u16;
    const DOT: u16 = b'.' as u16;
    let mut extended = if value.starts_with(&[SEPARATOR, SEPARATOR, QUESTION, SEPARATOR])
        || value.starts_with(&[SEPARATOR, SEPARATOR, DOT, SEPARATOR])
    {
        value
    } else if value.starts_with(&[SEPARATOR, SEPARATOR]) {
        let mut result: Vec<u16> = r"\\?\UNC\".encode_utf16().collect();
        result.extend_from_slice(&value[2..]);
        result
    } else {
        let mut result: Vec<u16> = r"\\?\".encode_utf16().collect();
        result.extend(value);
        result
    };
    extended.push(0);
    Ok(extended)
}

fn wide_null(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn invalid_acl(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::PermissionDenied, message)
}

struct LocalAllocation(PSECURITY_DESCRIPTOR);

impl Drop for LocalAllocation {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn applies_and_verifies_private_file_and_directory_acls() {
        let directory =
            std::env::temp_dir().join(format!("aludock-windows-acl-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).expect("test directory");
        secure_directory(&directory).expect("private directory ACL");
        assert_private_directory(&directory).expect("verified directory ACL");

        let file = directory.join("identity.key");
        fs::write(&file, b"not-a-real-key").expect("test file");
        secure_file(&file).expect("private file ACL");
        assert_private_file(&file).expect("verified file ACL");

        fs::remove_dir_all(directory).expect("cleanup");
    }
}
