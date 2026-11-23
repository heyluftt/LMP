//! Content checks for extensions that two kinds of files share.
//!
//! `.ts` and `.mts` name MPEG transport streams (broadcast recordings, AVCHD)
//! as well as TypeScript sources. The extension cannot tell them apart, so LMP
//! reads the first bytes: transport stream packets mean video, readable text
//! means the editor.

use std::{fs::File, io::Read, path::Path};

use crate::text_encoding;

const SYNC_BYTE: u8 = 0x47;
/// (packet size, offset of the sync byte inside the packet): plain TS, M2TS
/// with its 4-byte timestamp prefix, and DVB packets with Reed-Solomon parity.
const PACKET_LAYOUTS: [(usize, usize); 3] = [(188, 0), (192, 4), (204, 0)];
/// Packets after the first one that must start with a sync byte as well.
const FOLLOWING_PACKETS: usize = 4;
/// Enough for five packets of every layout and for the text check.
const SNIFF_BYTES: usize = 4096;

/// Extensions whose kind depends on the file content.
pub fn has_shared_extension(extension: &str) -> bool {
    matches!(extension, "ts" | "mts")
}

/// "video" or "text" for a file with a shared extension.
///
/// Files that cannot be read stay "video", as before this check existed; the
/// player then reports the actual error. Binary files without packet sync are
/// "video" too, so recordings that start mid-packet still reach the demuxer.
pub fn shared_extension_kind(path: &Path) -> &'static str {
    let Some(head) = read_head(path) else {
        return "video";
    };
    if starts_with_transport_stream(&head) || text_encoding::decode_auto(&head).binary {
        "video"
    } else {
        "text"
    }
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let file = File::open(path).ok()?;
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    file.take(SNIFF_BYTES as u64).read_to_end(&mut head).ok()?;
    Some(head)
}

/// True when the data opens with a sync byte that repeats in one packet raster.
///
/// At least one following packet is required, so a text file that merely
/// begins with "G" (0x47) is not taken for video.
fn starts_with_transport_stream(head: &[u8]) -> bool {
    PACKET_LAYOUTS.iter().any(|&(size, sync_offset)| {
        let positions = (0..=FOLLOWING_PACKETS)
            .map(|packet| sync_offset + packet * size)
            .take_while(|position| *position < head.len())
            .collect::<Vec<_>>();
        positions.len() >= 2
            && positions
                .iter()
                .all(|position| head[*position] == SYNC_BYTE)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn packets(size: usize, sync_offset: usize, count: usize) -> Vec<u8> {
        let mut data = vec![0xffu8; size * count];
        for packet in 0..count {
            data[packet * size + sync_offset] = SYNC_BYTE;
        }
        data
    }

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let folder = std::env::temp_dir().join(format!("lmp-sniff-tests-{}", std::process::id()));
        fs::create_dir_all(&folder).expect("temp folder");
        let file = folder.join(name);
        fs::write(&file, bytes).expect("write");
        file
    }

    #[test]
    fn recognizes_all_packet_layouts() {
        assert!(starts_with_transport_stream(&packets(188, 0, 8)));
        assert!(starts_with_transport_stream(&packets(192, 4, 8)));
        assert!(starts_with_transport_stream(&packets(204, 0, 8)));
        assert!(starts_with_transport_stream(&packets(188, 0, 2)));
    }

    #[test]
    fn rejects_text_and_lone_sync_bytes() {
        assert!(!starts_with_transport_stream(
            b"import { a } from \"./a\";\n"
        ));
        assert!(!starts_with_transport_stream(&packets(188, 0, 1)));
        let mut broken = packets(188, 0, 8);
        broken[188 * 3] = 0;
        assert!(!starts_with_transport_stream(&broken));
        // Two "G" characters in the raster are not enough when the third one is missing.
        let mut text = vec![b'a'; 800];
        text[0] = b'G';
        text[188] = b'G';
        assert!(!starts_with_transport_stream(&text));
    }

    #[test]
    fn classifies_files_by_content() {
        let video = temp_file("clip.ts", &packets(188, 0, 30));
        let avchd = temp_file("clip.mts", &packets(192, 4, 30));
        let source = temp_file("main.ts", "export const answer: number = 42;\n".as_bytes());
        let module = temp_file("tool.mts", "export default function run() {}\n".as_bytes());
        let empty = temp_file("empty.ts", b"");
        let binary = temp_file("cut.ts", &[0u8, 1, 2, 3, 0, 0, 7, 9]);
        assert_eq!(shared_extension_kind(&video), "video");
        assert_eq!(shared_extension_kind(&avchd), "video");
        assert_eq!(shared_extension_kind(&source), "text");
        assert_eq!(shared_extension_kind(&module), "text");
        assert_eq!(shared_extension_kind(&empty), "text");
        assert_eq!(shared_extension_kind(&binary), "video");
        assert_eq!(
            shared_extension_kind(Path::new("Z:/missing/none.ts")),
            "video"
        );
        for file in [video, avchd, source, module, empty, binary] {
            let _ = fs::remove_file(file);
        }
    }
}
