//! Image size limits shared by the providers (axe:images).
//!
//! Anthropic rejects a whole request (400 "image dimensions exceed max allowed
//! size for many-image requests: 2000 pixels") as soon as ONE image of a
//! request with many images is larger than 2000 px on a side. Because the image
//! stays in the transcript, every following turn failed too and the session was
//! dead. Images are therefore shrunk to [`MAX_IMAGE_SIDE`] when they are read
//! and again, defensively, when a request is built (for images already stored
//! in old transcripts).

use std::{
    borrow::Cow,
    collections::HashMap,
    io::Cursor,
    sync::{Mutex, OnceLock},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::message::{ChatMessage, Part};

/// Largest side accepted for an image sent to a model.
pub const MAX_IMAGE_SIDE: u32 = 2000;

/// Width and height read from the image header (PNG, JPEG, GIF, WebP).
pub fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        if bytes.len() >= 24 && &bytes[12..16] == b"IHDR" {
            return Some((be32(&bytes[16..20]), be32(&bytes[20..24])));
        }
        return None;
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        if bytes.len() >= 10 {
            return Some((le16(&bytes[6..8]), le16(&bytes[8..10])));
        }
        return None;
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return webp_dimensions(bytes);
    }
    if bytes.len() >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff {
        return jpeg_dimensions(bytes);
    }
    None
}

fn be16(b: &[u8]) -> u32 {
    u32::from(b[0]) << 8 | u32::from(b[1])
}
fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}
fn le16(b: &[u8]) -> u32 {
    u32::from(b[0]) | u32::from(b[1]) << 8
}
fn le24(b: &[u8]) -> u32 {
    u32::from(b[0]) | u32::from(b[1]) << 8 | u32::from(b[2]) << 16
}

fn webp_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let chunk = bytes.get(12..16)?;
    match chunk {
        b"VP8X" => {
            let b = bytes.get(24..30)?;
            Some((le24(&b[0..3]) + 1, le24(&b[3..6]) + 1))
        }
        b"VP8L" => {
            let b = bytes.get(21..25)?;
            let bits = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
            Some(((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1))
        }
        b"VP8 " => {
            let b = bytes.get(26..30)?;
            Some((le16(&b[0..2]) & 0x3fff, le16(&b[2..4]) & 0x3fff))
        }
        _ => None,
    }
}

fn jpeg_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut i = 2;
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xff {
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        if marker == 0xff {
            i += 1;
            continue;
        }
        if marker == 0xd8 || marker == 0x01 || (0xd0..=0xd7).contains(&marker) {
            i += 2;
            continue;
        }
        let len = be16(&bytes[i + 2..i + 4]) as usize;
        let is_sof = (0xc0..=0xcf).contains(&marker)
            && marker != 0xc4
            && marker != 0xc8
            && marker != 0xcc;
        if is_sof {
            let b = bytes.get(i + 5..i + 9)?;
            return Some((be16(&b[2..4]), be16(&b[0..2])));
        }
        if marker == 0xda || len < 2 {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// Dimensions of a base64 image; decodes only a prefix when it is enough.
pub fn base64_image_dimensions(data: &str) -> Option<(u32, u32)> {
    let data = data.trim();
    let prefix_len = data.len().min(256 * 1024) / 4 * 4;
    if let Ok(prefix) = BASE64_STANDARD.decode(&data[..prefix_len]) {
        if let Some(dims) = image_dimensions(&prefix) {
            return Some(dims);
        }
    }
    if prefix_len < data.len() {
        return image_dimensions(&BASE64_STANDARD.decode(data).ok()?);
    }
    None
}

/// True when the image has a known size within `max_side` (unknown formats
/// are left alone: the provider decides).
pub fn base64_image_within(data: &str, max_side: u32) -> bool {
    match base64_image_dimensions(data) {
        Some((w, h)) => w <= max_side && h <= max_side,
        None => true,
    }
}

/// Shrinks raw image bytes so that no side exceeds `max_side`.
/// `Ok(None)` = already small enough; `Err` = could not decode/encode.
pub fn shrink_image_bytes(
    bytes: &[u8],
    max_side: u32,
) -> Result<Option<(&'static str, Vec<u8>)>, String> {
    let Some((w, h)) = image_dimensions(bytes) else {
        return Ok(None);
    };
    if w <= max_side && h <= max_side {
        return Ok(None);
    }
    let format = image::guess_format(bytes).map_err(|e| e.to_string())?;
    let decoded = image::load_from_memory(bytes).map_err(|e| e.to_string())?;
    let resized = decoded.resize(max_side, max_side, image::imageops::FilterType::Triangle);
    let mut out = Vec::new();
    if format == image::ImageFormat::Jpeg {
        let rgb = image::DynamicImage::ImageRgb8(resized.to_rgb8());
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85);
        rgb.write_with_encoder(encoder).map_err(|e| e.to_string())?;
        Ok(Some(("image/jpeg", out)))
    } else {
        resized
            .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        Ok(Some(("image/png", out)))
    }
}

/// Base64 variant of [`shrink_image_bytes`]; returns `(media_type, base64)`.
pub fn shrink_base64_image(data: &str, max_side: u32) -> Result<Option<(String, String)>, String> {
    if base64_image_within(data, max_side) {
        return Ok(None);
    }
    let key = cache_key(data, max_side);
    if let Some(hit) = shrink_cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        return Ok(Some(hit));
    }
    let bytes = BASE64_STANDARD.decode(data.trim()).map_err(|e| e.to_string())?;
    let Some((media_type, out)) = shrink_image_bytes(&bytes, max_side)? else {
        return Ok(None);
    };
    let result = (media_type.to_string(), BASE64_STANDARD.encode(out));
    if let Ok(mut cache) = shrink_cache().lock() {
        if cache.len() >= 64 {
            cache.clear();
        }
        cache.insert(key, result.clone());
    }
    Ok(Some(result))
}

type CacheKey = (usize, u32, u64);

fn cache_key(data: &str, max_side: u32) -> CacheKey {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut hasher);
    (data.len(), max_side, hasher.finish())
}

fn shrink_cache() -> &'static Mutex<HashMap<CacheKey, (String, String)>> {
    static CACHE: OnceLock<Mutex<HashMap<CacheKey, (String, String)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Returns a copy of the transcript where every image larger than `max_side`
/// is shrunk, or the transcript itself when nothing had to change. Images that
/// cannot be shrunk are left as is (the provider replaces them by a note).
pub fn fit_transcript_images(messages: &[ChatMessage], max_side: u32) -> Cow<'_, [ChatMessage]> {
    let needs = |data: &str| !data.trim().is_empty() && !base64_image_within(data, max_side);
    let any = messages.iter().any(|m| {
        m.parts.iter().any(|p| match p {
            Part::Image { data, .. } => needs(data),
            Part::ToolResult { images, .. } => images.iter().any(|i| needs(&i.data)),
            _ => false,
        })
    });
    if !any {
        return Cow::Borrowed(messages);
    }
    let mut owned = messages.to_vec();
    for message in &mut owned {
        for part in &mut message.parts {
            match part {
                Part::Image {
                    media_type, data, ..
                } if needs(data) => {
                    if let Ok(Some((m, d))) = shrink_base64_image(data, max_side) {
                        *media_type = m;
                        *data = d;
                    }
                }
                Part::ToolResult { images, .. } => {
                    for image in images.iter_mut().filter(|i| needs(&i.data)) {
                        if let Ok(Some((m, d))) = shrink_base64_image(&image.data, max_side) {
                            image.media_type = m;
                            image.data = d;
                        }
                    }
                }
                _ => {}
            }
        }
    }
    Cow::Owned(owned)
}

/// Solid PNG of the given size (used by tests of the provider crates).
/// In-place variant of [`fit_transcript_images`] for owned requests.
pub fn fit_transcript_images_in_place(messages: &mut Vec<ChatMessage>, max_side: u32) {
    if let Cow::Owned(owned) = fit_transcript_images(messages, max_side) {
        *messages = owned;
    }
}

#[doc(hidden)]
pub fn test_png(width: u32, height: u32) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(width, height, image::Rgb([200, 30, 30]));
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dimensions_and_shrinks_png_and_jpeg() {
        let png = test_png(3000, 1500);
        assert_eq!(image_dimensions(&png), Some((3000, 1500)));
        let (media, out) = shrink_image_bytes(&png, MAX_IMAGE_SIDE).unwrap().unwrap();
        assert_eq!(media, "image/png");
        assert_eq!(image_dimensions(&out), Some((2000, 1000)));

        let img = image::DynamicImage::ImageRgb8(image::RgbImage::new(2500, 3100));
        let mut jpg = Vec::new();
        img.write_to(&mut Cursor::new(&mut jpg), image::ImageFormat::Jpeg).unwrap();
        assert_eq!(image_dimensions(&jpg), Some((2500, 3100)));
        let (media, out) = shrink_image_bytes(&jpg, MAX_IMAGE_SIDE).unwrap().unwrap();
        assert_eq!(media, "image/jpeg");
        let (w, h) = image_dimensions(&out).unwrap();
        assert!(w <= 2000 && h == 2000);

        assert!(shrink_image_bytes(&test_png(10, 10), MAX_IMAGE_SIDE).unwrap().is_none());
    }

    #[test]
    fn gif_and_webp_headers() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&[0xb8, 0x0b, 0x10, 0x00]);
        assert_eq!(image_dimensions(&gif), Some((3000, 16)));
        let mut webp = b"RIFF\0\0\0\0WEBPVP8X".to_vec();
        webp.extend_from_slice(&[0; 8]);
        webp.extend_from_slice(&[0xb7, 0x0b, 0x00, 0x09, 0x00, 0x00]);
        assert_eq!(image_dimensions(&webp), Some((3000, 10)));
    }
}
