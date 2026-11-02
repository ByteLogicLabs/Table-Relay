//! Run a CLI inside a Windows pseudo console (ConPTY) and read what it renders.
//!
//! Some CLIs write their answer straight to the console and nothing to a
//! redirected stdout — Antigravity's `agy` does, so a piped spawn read an empty
//! stream and the chat showed "[no output from CLI]". Under a pseudo console
//! the same output arrives as a VT byte stream; [`VtText`] turns it back into
//! plain text lines.

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::sync::Arc;

use tokio::sync::mpsc;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0};
use windows_sys::Win32::Storage::FileSystem::ReadFile;
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, TerminateProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
    STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

/// Console size. Tall enough that a long answer never scrolls (scrolling makes
/// the console repaint with cursor moves instead of plain newlines) and wide
/// enough that lines rarely wrap.
const ROWS: i16 = 9999;
const COLS: i16 = 400;

struct OwnedHandle(HANDLE);

// Plain kernel handles; the owning thread is the only one closing them.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}

impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() && self.0 != INVALID_HANDLE_VALUE {
            unsafe { CloseHandle(self.0) };
        }
    }
}

/// The running process. Killed on drop if it is still running.
pub struct PtyProcess {
    process: Arc<OwnedHandle>,
}

impl PtyProcess {
    pub fn kill(&self) {
        unsafe { TerminateProcess(self.process.0, 1) };
    }

    /// Wait for exit; `None` if the exit code couldn't be read.
    pub async fn wait(&self) -> Option<u32> {
        let process = self.process.clone();
        tokio::task::spawn_blocking(move || unsafe {
            WaitForSingleObject(process.0, INFINITE);
            let mut code = 0u32;
            (GetExitCodeProcess(process.0, &mut code) != 0).then_some(code)
        })
        .await
        .ok()
        .flatten()
    }
}

impl Drop for PtyProcess {
    fn drop(&mut self) {
        if unsafe { WaitForSingleObject(self.process.0, 0) } != WAIT_OBJECT_0 {
            self.kill();
        }
    }
}

pub struct Spawned {
    /// The rendered output as plain-text lines; closes when the process has
    /// exited and the console is drained.
    pub lines: mpsc::UnboundedReceiver<String>,
    pub process: PtyProcess,
}

/// Start `program args…` in a fresh pseudo console. `env` overrides entries
/// of the inherited environment.
pub fn spawn(
    program: &Path,
    args: &[String],
    cwd: Option<&Path>,
    env: &[(OsString, OsString)],
) -> std::io::Result<Spawned> {
    let last_error = std::io::Error::last_os_error;
    unsafe {
        // Pipes: we write the console's input, read its output.
        let (mut in_read, mut in_write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        let (mut out_read, mut out_write): (HANDLE, HANDLE) = (std::ptr::null_mut(), std::ptr::null_mut());
        if CreatePipe(&mut in_read, &mut in_write, std::ptr::null(), 0) == 0 {
            return Err(last_error());
        }
        let (in_read, in_write) = (OwnedHandle(in_read), OwnedHandle(in_write));
        if CreatePipe(&mut out_read, &mut out_write, std::ptr::null(), 0) == 0 {
            return Err(last_error());
        }
        let (out_read, out_write) = (OwnedHandle(out_read), OwnedHandle(out_write));

        let mut hpc: HPCON = 0;
        let hr = CreatePseudoConsole(COORD { X: COLS, Y: ROWS }, in_read.0, out_write.0, 0, &mut hpc);
        if hr < 0 {
            return Err(std::io::Error::other(format!("CreatePseudoConsole failed: {hr:#x}")));
        }
        // The console holds its own duplicates of these ends.
        drop(in_read);
        drop(out_write);
        let console = PseudoConsole(hpc);

        // Attach the console to the child through the attribute list.
        let mut size = 0usize;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size);
        let mut attrs = vec![0u8; size];
        let list = attrs.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
            return Err(last_error());
        }
        let ok = UpdateProcThreadAttribute(
            list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            console.0 as *const core::ffi::c_void,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        if ok == 0 {
            let e = last_error();
            DeleteProcThreadAttributeList(list);
            return Err(e);
        }

        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = list;
        // Don't hand the child our own stdio (a console parent's would win
        // over the pseudo console).
        si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        si.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        si.StartupInfo.hStdError = INVALID_HANDLE_VALUE;

        let mut cmdline = wide(&command_line(program, args));
        let env_block = environment_block(env);
        let cwd_w = cwd.map(|c| wide(c.as_os_str()));
        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            std::ptr::null(),
            cmdline.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            env_block.as_ptr() as *const core::ffi::c_void,
            cwd_w.as_ref().map_or(std::ptr::null(), |w| w.as_ptr()),
            &si.StartupInfo,
            &mut pi,
        );
        let spawn_err = (ok == 0).then(last_error);
        DeleteProcThreadAttributeList(list);
        if let Some(e) = spawn_err {
            return Err(e);
        }
        drop(OwnedHandle(pi.hThread));
        let process = Arc::new(OwnedHandle(pi.hProcess));

        // Reader: console output → plain-text lines.
        let (tx, rx) = mpsc::unbounded_channel();
        std::thread::spawn(move || {
            let out_read = out_read;
            let mut text = VtText::default();
            let mut buf = [0u8; 8192];
            loop {
                let mut n = 0u32;
                let ok = ReadFile(out_read.0, buf.as_mut_ptr(), buf.len() as u32, &mut n, std::ptr::null_mut());
                if ok == 0 || n == 0 {
                    break;
                }
                for line in text.push(&buf[..n as usize]) {
                    if tx.send(line).is_err() {
                        return;
                    }
                }
            }
            if let Some(line) = text.finish() {
                let _ = tx.send(line);
            }
        });

        // Closer: once the process exits, close the console so the reader
        // drains what's left and sees end-of-file.
        let waited = process.clone();
        std::thread::spawn(move || {
            WaitForSingleObject(waited.0, INFINITE);
            drop(console);
            drop(in_write);
        });

        Ok(Spawned { lines: rx, process: PtyProcess { process } })
    }
}

struct PseudoConsole(HPCON);

unsafe impl Send for PseudoConsole {}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        unsafe { ClosePseudoConsole(self.0) };
    }
}

fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

/// A command line `CommandLineToArgvW` (and Go, and the MSVC runtime) split
/// back into exactly `program` + `args`.
fn command_line(program: &Path, args: &[String]) -> OsString {
    let mut line = String::new();
    line.push('"');
    line.push_str(&program.to_string_lossy());
    line.push('"');
    for arg in args {
        line.push(' ');
        quote_arg(arg, &mut line);
    }
    OsString::from(line)
}

fn quote_arg(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for c in arg.chars() {
        if c == '\\' {
            backslashes += 1;
            continue;
        }
        if c == '"' {
            // Escape the backslashes before a quote, then the quote itself.
            out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat('\\').take(backslashes));
        }
        out.push(c);
        backslashes = 0;
    }
    // Backslashes before the closing quote must not escape it.
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
}

/// The inherited environment with `overrides` applied, as a sorted
/// `KEY=value\0…\0` UTF-16 block. Keys compare case-insensitively.
fn environment_block(overrides: &[(OsString, OsString)]) -> Vec<u16> {
    let mut vars: std::collections::BTreeMap<String, (OsString, OsString)> = std::env::vars_os()
        .map(|(k, v)| (k.to_string_lossy().to_uppercase(), (k, v)))
        .collect();
    for (k, v) in overrides {
        vars.insert(k.to_string_lossy().to_uppercase(), (k.clone(), v.clone()));
    }
    let mut block = Vec::new();
    for (k, v) in vars.values() {
        block.extend(k.encode_wide());
        block.push(b'=' as u16);
        block.extend(v.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

/// Turns a console's VT output back into text lines: drops escape sequences
/// (colours, titles, cursor show/hide), and maps the few cursor moves a
/// console uses in place of plain text — "move forward n" for runs of spaces,
/// "go to row r" for blank lines.
#[derive(Default)]
pub(crate) struct VtText {
    /// Bytes of an incomplete UTF-8 sequence or escape sequence.
    pending: Vec<u8>,
    line: String,
    /// 1-based row the cursor is on.
    row: u32,
    /// The cursor went back to the start of the line (`\r`, "go to column
    /// 1"): the next text overwrites it — how spinners and progress lines
    /// redraw.
    at_line_start: bool,
}

impl VtText {
    /// Feed output; returns the lines completed by it.
    pub(crate) fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let data = std::mem::take(&mut self.pending);
        let mut lines = Vec::new();
        let mut i = 0;
        while i < data.len() {
            let b = data[i];
            if b == 0x1b {
                match escape_len(&data[i..]) {
                    Some(len) => {
                        self.apply_escape(&data[i..i + len], &mut lines);
                        i += len;
                    }
                    None => {
                        // Incomplete — wait for the rest.
                        self.pending.extend_from_slice(&data[i..]);
                        return lines;
                    }
                }
                continue;
            }
            if b == b'\n' {
                self.end_line(&mut lines);
                i += 1;
                continue;
            }
            if b == b'\r' {
                self.at_line_start = true;
                i += 1;
                continue;
            }
            if b < 0x20 || b == 0x7f {
                i += 1; // BEL, … carry no text
                continue;
            }
            let width = utf8_len(b);
            if i + width > data.len() {
                self.pending.extend_from_slice(&data[i..]);
                return lines;
            }
            if self.at_line_start {
                self.line.clear();
                self.at_line_start = false;
            }
            self.line.push_str(&String::from_utf8_lossy(&data[i..i + width]));
            i += width;
        }
        lines
    }

    /// The last line, if the output didn't end with a newline.
    pub(crate) fn finish(&mut self) -> Option<String> {
        let line = std::mem::take(&mut self.line);
        (!line.trim().is_empty()).then_some(line)
    }

    fn end_line(&mut self, lines: &mut Vec<String>) {
        lines.push(std::mem::take(&mut self.line));
        self.row = self.row.max(1) + 1;
        self.at_line_start = false;
    }

    fn apply_escape(&mut self, seq: &[u8], lines: &mut Vec<String>) {
        // Only CSI sequences (ESC [ … final) can stand for text.
        if seq.len() < 3 || seq[1] != b'[' {
            return;
        }
        let final_byte = seq[seq.len() - 1];
        let params = std::str::from_utf8(&seq[2..seq.len() - 1]).unwrap_or("");
        let param = |n: usize, default: u32| {
            params
                .split(';')
                .nth(n)
                .and_then(|p| p.parse::<u32>().ok())
                .unwrap_or(default)
        };
        match final_byte {
            // Cursor forward n: a run of spaces.
            b'C' => self.line.extend(std::iter::repeat(' ').take(param(0, 1).min(COLS as u32) as usize)),
            // Cursor to row r, column c. Down: the rows in between are blank
            // lines. Same row, column 1: the line is about to be redrawn.
            // (Moving up would be a repaint; the tall console avoids those.)
            b'H' | b'f' => {
                let target = param(0, 1);
                let row = self.row.max(1);
                if target > row {
                    while self.row.max(1) < target {
                        self.end_line(lines);
                    }
                } else if target == row && param(1, 1) == 1 {
                    self.at_line_start = true;
                }
                self.row = self.row.max(1);
            }
            // Cursor to column 1 of this line.
            b'G' if param(0, 1) == 1 => self.at_line_start = true,
            // Erase the line (from column 1, or all of it).
            b'K' if self.at_line_start || param(0, 0) == 2 => {
                self.line.clear();
                self.at_line_start = false;
            }
            _ => {}
        }
    }
}

fn utf8_len(first: u8) -> usize {
    match first {
        0xc0..=0xdf => 2,
        0xe0..=0xef => 3,
        0xf0..=0xf7 => 4,
        _ => 1,
    }
}

/// Length of the escape sequence at the start of `s`, or `None` if it is not
/// complete yet.
fn escape_len(s: &[u8]) -> Option<usize> {
    let kind = *s.get(1)?;
    match kind {
        // CSI: parameters/intermediates, then a final byte in 0x40..=0x7e.
        b'[' => s[2..].iter().position(|b| (0x40..=0x7e).contains(b)).map(|p| p + 3),
        // OSC / DCS / …: until BEL or ESC \.
        b']' | b'P' | b'_' | b'^' | b'X' => {
            let mut j = 2;
            while j < s.len() {
                if s[j] == 0x07 {
                    return Some(j + 1);
                }
                if s[j] == 0x1b && s.get(j + 1) == Some(&b'\\') {
                    return Some(j + 2);
                }
                j += 1;
            }
            None
        }
        // Charset selection: ESC ( B and friends.
        b'(' | b')' | b'*' | b'+' => s.get(2).map(|_| 3),
        _ => Some(2),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed(chunks: &[&[u8]]) -> Vec<String> {
        let mut t = VtText::default();
        let mut out = Vec::new();
        for c in chunks {
            out.extend(t.push(c));
        }
        out.extend(t.finish());
        out
    }

    #[test]
    fn strips_escapes_from_real_agy_output() {
        let raw = b"\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H1 Fig\r\n2 Date\r\n7 Peach\x1b]0;C:\\agy.exe\x07\x1b[?25h\r\n8 Apple\r\n";
        assert_eq!(feed(&[raw]), vec!["1 Fig", "2 Date", "7 Peach", "8 Apple"]);
    }

    #[test]
    fn handles_sequences_and_characters_split_across_reads() {
        let raw = "caf\u{e9} \u{2014} ok\r\n".as_bytes();
        let (a, b) = raw.split_at(4); // splits the é
        assert_eq!(
            feed(&[b"\x1b[3", b"8;5;1mx\x1b[0m\r\n", b"\x1b]0;ti", b"tle\x07", a, b]),
            vec!["x", "café — ok"]
        );
    }

    #[test]
    fn cursor_moves_become_spaces_and_blank_lines() {
        // Row 1 "a   b", rows 2-3 blank, row 4 "c".
        let raw = b"\x1b[Ha\x1b[3Cb\r\n\x1b[4;1Hc\r\n";
        assert_eq!(feed(&[raw]), vec!["a   b", "", "", "c"]);
    }

    #[test]
    fn spinner_redraws_leave_only_the_final_text() {
        // Shape of `agy models` under a console.
        let raw = "\x1b[2J\x1b[H\u{280b} Fetching...\x1b[?25l\x1b[H\u{2819} Fetching...\x1b[H\x1b[K\x1b[?25hgemini-a     Gemini A\r\nclaude-b     Claude B\r\n";
        assert_eq!(feed(&[raw.as_bytes()]), vec!["gemini-a     Gemini A", "claude-b     Claude B"]);
        // A bare carriage return redraws the line too.
        assert_eq!(feed(&[b"50%\r100%\r\ndone\r\n"]), vec!["100%", "done"]);
    }

    #[test]
    fn quotes_arguments_like_commandlinetoargvw() {
        let mut s = String::new();
        quote_arg(r#"say "hi" to C:\dir\"#, &mut s);
        assert_eq!(s, r#""say \"hi\" to C:\dir\\""#);
        let mut s = String::new();
        quote_arg("plain", &mut s);
        assert_eq!(s, "plain");
        let mut s = String::new();
        quote_arg("", &mut s);
        assert_eq!(s, "\"\"");
    }
}
