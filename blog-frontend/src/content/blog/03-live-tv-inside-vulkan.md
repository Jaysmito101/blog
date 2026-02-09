---
title: "Building a Live TV Player from Scratch: HLS Streaming, MPEG-TS Demuxing, H.264 Parsing, and Vulkan Video Decoding"
pubDate: "2025-01-15 10:00:00"
description: "Ever wondered how excactly any Livestream/Live TV channel works? One day I did, and took a leap of faith into the rabbitt hole of media coding, data transmission, hardware acceleration and what not with the goal of \"Getting to the Bottom of It\". This is my documented journey of adding a Live TV Player inside my Vulkan rendering engine just for the fun of it, and in the process learning about and implementing(however incomplete it maybe) a live media stream handling pipeline without using any existing media libraries, cuz why not?"
tags: ["Vulkan", "Video", "Graphics", "Advanced", "C"]
cover: "../../assets/blog/03-vulkan-video/thumb.png"
---

![Blog Post Cover Image](../../assets/blog/03-vulkan-video/demo.gif)

*A better quality video is available in the [Demo section](#demo) below.*


## The idea? 

Before actually diving into the technical details, let me share my motivation for this project. 

I have been playing around with the Vulkan Video Extensions for a bit now, for projects here and there and I do really like it, but never really had the chance to go a bit futher with it, starting from the very basics, so I was indeed searching for an excuse to make something big with it.

And then one day, while working for another project, I had to deal with setting up a video stream locally for some tests, and I had to read up a bit on how HLS(HTTP Live Streaming) works and the plumbing around it, it was simple with a couple `ffmpeg` commands and setting up a basic server nothing fancy(for thats all I needed). But this got me really curios in the inner workings of how it worked. And the DUMB me of the time though *"Hey that seems rather easy doesnt it? Its just dumping chunks and playing them right?"* and I though why not use this idea to actually satisfy my itch of working with Vulkan Video in a more meaningful way, as in I wont be building yet another *Simple* video player, but something much more interesting.

And this it, and over the course of a few weeks I came to realize how utterly wrong I was thinking that its so simple, and was facinated by literally how much is happening behind the scnes and how much tech is involved for something as common as watching a video on youtube.

---

## The constraints?

Now, I do like to make a lot of things from scratch rather than using existing libraries, and however stupid my reasoning may sound it is: most of the time I am too lazy to just learn the APIs of a new library and get used to the patterns used there for my personal projects. And whats wrong with re-inventing a worse version of the wheel when its a hobby project just for fun? So to challenge myself in this case too, I gave myself a constraint, I cannot use any existing library for the media work. Anything else is fine, like I all good with GLFW, or stuff like using something to do the networking for me as I have no interest in building a TCP stack here.

So it leaves us with. No FFmpeg. No libav. No GStreamer. No parsers/demuxers for the HLS playlists, or the Transport stream files or even the H264 files, all that has to be made by me.

This constraint led to the creation of three entirely new libraries. all part of the [libpico](https://github.com/Jaysmito101/libpico) project, my version of stb, a collection of single header C libraries:

1. **picoM3U8**: A parser for HLS M3U8 playlists, implementing the relevant portions of [RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216).
2. **picoMpegTS**: A demuxer for MPEG Transport Streams, implemented based on the [ITU-T H.222.0](https://www.itu.int/rec/T-REC-H.222.0-202308-S/en) specification.
3. **picoH264**: A parser for H.264/AVC bitstreams, implemented based on the [ITU-T H.264 (V15)](https://handle.itu.int/11.1002/1000/15935) specification.

Additionally, a fourth library was created:

4. **picoAudio**: A cross platform audio decoding library using OS-native APIs (Media Foundation on Windows, AudioToolbox on macOS)

Each of these libraries represents weeks of work reading specifications, writing parsers, debugging edge cases, and testing against real world media streams(which I swear are very rare find public ones due to copyright issues). Together, they form a complete media pipeline capable of taking a URL pointing to an HLS stream and producing raw decoded video frames and PCM audio samples without a single line of code from any existing media framework.

Let us now dive into each piece of this puzzle, starting with the protocol that makes it all possible.

---

## Understanding HLS

Before we look at any code, it is essential to understand what HLS actually is and how it works. HTTP Live Streaming, initially developed by Apple and published as an RFC (RFC 8216), is an adaptive bitrate streaming protocol that delivers media content over standard HTTP connections.

![HLS Protocol Overview](../../assets/blog/03-vulkan-video/hls_protocol.svg)
*NOTE: This diagram is AI-generated as I ran out of patiance trying to make it by hand, but I tried my best to ensure that the information is accurate, is there are any issues please forgive me for that, and feel free to reach out.*

### The HLS Architecture

At its core, HLS is simple in concept:

1. A media encoder takes a live video/audio feed and encodes it into one or more quality levels (bitrates). Also it could be coming from multiple cameras or audio sources, lets say two different cameras for the same event.
2. A stream segmenter divides the encoded media into small files called media segments, typically 2-10 seconds long(can be variable and can change during streaming, atleast from what I have seen).
3. An index file (the M3U8 playlist) is generated that lists the URLs of these segments in order.
4. A web server hosts both the playlist and the media segments.
5. A client fetches the playlist, determines which segments to download, downloads them, and plays them back.

For live streams, the playlist is continuously updated by the server with new segments as they become available. The client periodically re-fetches the playlist to discover new content.

One really interesting part here is it is named "HTTP Live Streaming" but it is really just for Live content, you can stream any content even pre-recorded ones with this protocol.

Another interesting thing is that HLS works with any plain old static HTTP file server, there is no special server side logic, its just updating the static files, its the client taht manages all the complexity of fetching the playlist, parsing it, downloading the segments, and playing them back in the correct order. This is one of the reasons why HLS is so widely adopted it can be served from any CDN or web server without special configuration.

### Playlist Types

HLS defines two types of playlists:

**Master Playlists** contain references to multiple variant streams, each at a different bitrate or resolution or even different sources like multiple streams from different camera angles. This enables adaptive bitrate streaming, that is, the client can switch between quality levels based on network conditions. A master playlist looks something like this:

```
#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720
http://example.com/720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1920x1080
http://example.com/1080p.m3u8
```

**Media Playlists** contain the actual references to media segments. These are what the player downloads and plays. A media playlist looks like:

```
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:2680
#EXTINF:9.009,
http://example.com/segment2680.ts
#EXTINF:9.009,
http://example.com/segment2681.ts
#EXTINF:9.009,
http://example.com/segment2682.ts
```

The `#EXT-X-MEDIA-SEQUENCE` tag tells the client the sequence number of the first segment in the playlist. For live streams, the server removes old segments and adds new ones, incrementing this number. The `#EXTINF` tag specifies the duration of each segment in seconds. And honestly for a bare bones player like ours, this is all we need to know.

### Media Segments

In HLS, media segments are typically packaged as MPEG Transport Stream (.ts) files, though fragmented MP4 (fMP4) is also supported in newer versions but for simplicity's sake lets pretend we dont know about that. Each .ts file contains multiplexed audio and video elementary streams wrapped in PES (Packetized Elementary Stream) packets, which are themselves carried in 188-byte transport stream packets.

This is where the complexity begins. To get from a .ts file to raw video frames and audio samples, you need to:

1. Parse the MPEG-TS container to extract individual PES packets.
2. Identify which PES packets contain video (H.264) and which contain audio (typically AAC ADTS).
3. Reassemble the video elementary stream from the PES packet payloads.
4. Parse the H.264 bitstream to extract individual frames (NAL units).
5. Decode the NAL units using a video decoder (in our case, the Vulkan Video hardware decoder).
6. Decode the audio elementary stream (AAC) into PCM samples for playback.
7. And at every point of time ensure that we are keeping everything in sync, that is the audio and video are played back at the correct times according to their timestamps.

Each of these steps is a significant engineering challenge in its own right. Let us tackle them one at a time.

---

## Part I: Parsing HLS Playlists (picoM3U8)

M3U8 files are extended M3U (multimedia playlist) files encoded in UTF-8. Despite their apparent simplicity, that they are just text files with tags, a correct parser must handle a surprising number of edge cases and tag types.

### The M3U8 Specification

The parser was implemented based on [RFC 8216](https://datatracker.ietf.org/doc/html/rfc8216), which defines the HLS protocol. The RFC specifies numerous tags, each with specific syntax rules and semantics. The most important ones for our purposes are:

- `#EXTM3U`: Must be the first line; identifies the file as an Extended M3U file.
- `#EXT-X-VERSION`: Specifies the compatibility version of the playlist.
- `#EXT-X-TARGETDURATION`: The maximum duration of any media segment in the playlist.
- `#EXT-X-MEDIA-SEQUENCE`: The media sequence number of the first media segment in the playlist.
- `#EXTINF`: Specifies the duration and optional title of the next media segment.
- `#EXT-X-KEY`: Specifies how media segments are encrypted (if at all, as playing encrypted streams is way beyond the scope of this project).
- `#EXT-X-STREAM-INF`: Specifies a variant stream in a master playlist.

### Library Design

I choose to go with the stb stile of library design, and kept a super simple C API for the parser:

```c
picoM3U8Result picoM3U8PlaylistParse(
    const char *data,
    uint32_t dataSize,
    picoM3U8Playlist *outPlaylist
);

void picoM3U8PlaylistDestroy(picoM3U8Playlist playlist);
```

The `picoM3U8Playlist` structure differentiates between master playlists (containing variant stream references) and media playlists (containing segment URIs). The parser identifies the playlist type automatically during parsing.

### Parsing Strategy

The parser works line-by-line. Each line is classified as either:
- A **tag line** (starts with `#EXT`).
- A **comment line** (starts with `#` but not `#EXT`).
- A **URI line** (anything else: the URI of a media segment or variant stream).

For tag lines, the parser extracts the tag name and its attribute list (if any). Attributes are comma-separated key-value pairs, where values can be quoted strings, integers, floating-point numbers, or enumerated values.

The parser maintains state as it processes lines. When it encounters an `#EXTINF` tag, it records the duration and waits for the next URI line to associate it with a segment. When it encounters `#EXT-X-STREAM-INF`, it waits for the next URI to create a variant stream entry.

### Integration with AVD

In the HLS player scene, the M3U8 parser is used in the source download worker thread. When a source URL is fetched, the raw text content is passed to `picoM3U8PlaylistParse`. The resulting playlist structure is then iterated to extract media segment URLs:

```c
picoM3U8Playlist playlist = NULL;
picoM3U8Result result = picoM3U8PlaylistParse(data, (uint32_t)strlen(data), &playlist);

if (result != PICO_M3U8_RESULT_SUCCESS) {
    AVD_LOG_ERROR("Failed to parse HLS playlist: %s", picoM3U8ResultToString(result));
    return;
}

if (playlist->type != PICO_M3U8_PLAYLIST_TYPE_MEDIA) {
    AVD_LOG_ERROR("Master playlists are not supported yet");
    return;
}

for (uint32_t i = 0; i < playlist->media.mediaSegmentCount; i++) {
    picoM3U8MediaSegment segment = &playlist->media.mediaSegments[i];
    // resolve relative URL, enqueue for download...
}
```

There is a notable design decision here: the current implementation only supports media playlists, not master playlists. For a production player, you would want to parse master playlists and select the appropriate variant stream based on available bandwidth. However, since the primary goal was to decode and display live video, supporting media playlists directly was sufficient.

The `mediaSequence` field is particularly important for live streams. It tells the player the absolute sequence number of the first segment in the playlist. Combined with each segment's index within the playlist, this allows the player to compute a globally unique segment ID, which is used throughout the system to track which segments have been downloaded, demuxed, and played.

### Development History

Looking at the git history of libpico, picoM3U8 was one of the earlier libraries in the collection. The development followed a pattern common to all the pico libraries: start with the simplest possible working implementation, then iteratively add support for more tags and edge cases as real-world streams exposed gaps in the parser.

One of the later additions was the `allowCache` field and support for the `EXT-X-ALLOW-CACHE` tag, added as the HLS player began encountering a wider variety of live streams in the wild. This kind of iterative development — implement, test against real streams, fix, repeat — is a recurring theme throughout this project.

---

## Part II: picoMpegTS — Demultiplexing MPEG Transport Streams

Once we have the URLs of media segments from the M3U8 parser, we need to download them and extract their audio and video content. HLS typically uses MPEG Transport Stream (.ts) as its container format, and this is where picoMpegTS comes in.

![MPEG-TS Packet Structure](../../assets/blog/03-vulkan-video/mpegts_structure.svg)

### What is MPEG-TS?

MPEG Transport Stream is a standard digital container format for the transmission of audio, video, and data. It was originally designed for broadcast applications (digital TV, satellite) where the transmission medium is unreliable — dropped packets, bit errors, and out-of-order delivery are all expected. Because of this heritage, MPEG-TS is designed to be highly resilient:

- The stream is divided into fixed-size 188-byte **transport packets**.
- Each packet starts with a synchronization byte (0x47).
- Packets carry a 13-bit **PID (Packet Identifier)** that identifies which elementary stream the packet belongs to.
- The stream uses **program-specific information (PSI)** tables to describe its structure.

### The Transport Stream Structure

An MPEG-TS stream contains several layers of structure:

**Transport Packets**: The atomic unit of the stream. Each packet has a 4-byte header followed by an optional adaptation field and payload data. The header contains:
- Sync byte (0x47)
- Transport error indicator
- Payload unit start indicator
- Transport priority
- PID (13 bits)
- Transport scrambling control
- Adaptation field control
- Continuity counter

**Program-Specific Information (PSI)**: Special tables carried in dedicated PIDs:
- **PAT (Program Association Table)**: PID 0. Maps program numbers to the PIDs of their PMT (Program Map Table).
- **PMT (Program Map Table)**: Lists all elementary streams in a program and their PIDs and types.
- **CAT (Conditional Access Table)**: For encrypted streams.
- **NIT (Network Information Table)**: Network-level information.

**PES (Packetized Elementary Stream) Packets**: The audio and video data is first wrapped in PES packets, which can span multiple transport packets. PES packets have their own headers containing:
- Stream ID (identifies the type: audio, video, etc.)
- Packet length
- PTS (Presentation Timestamp)
- DTS (Decoding Timestamp)
- Various flags

### The ITU-T H.222.0 Specification

picoMpegTS was implemented based on the ITU-T H.222.0 v9 (08/2023) specification, with additional references to the excellent [tsduck](https://tsduck.io/docs/mpegts-introduction.pdf) introduction document and [FFmpeg's MPEG-TS implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mpegts.c).

The H.222.0 specification is a dense, 400+ page document. Implementing it from scratch required careful reading of the transport packet syntax, the PSI table structures, and the PES packet format. Not every part of the specification needed to be implemented — for our purposes, we needed:

1. Transport packet parsing and synchronization.
2. PAT parsing to find the PMT PID.
3. PMT parsing to identify video (H.264) and audio (AAC) streams and their PIDs.
4. PES packet reassembly from transport packet payloads.
5. Stream type identification to distinguish between H.264 video and AAC audio.

### Library Architecture

picoMpegTS provides a buffered parsing interface. You create a parser, feed it data buffers, and then query the parsed results:

```c
picoMpegTS mpegts = picoMpegTSCreate(false);

if (picoMpegTSAddBuffer(mpegts, buffer, bufferSize) != PICO_MPEGTS_RESULT_SUCCESS) {
    // handle error
}

size_t pesPacketCount = 0;
picoMpegTSPESPacket *pesPackets = picoMpegTSGetPESPackets(mpegts, &pesPacketCount);
```

The boolean parameter to `picoMpegTSCreate` controls whether the parser makes internal copies of the data. When set to `false`, it operates in zero-copy mode for better performance, assuming the caller keeps the buffer alive for the lifetime of the parser.

### Demuxing in Detail

The demuxing process works as follows:

**Step 1: Synchronization**. The parser scans the input buffer for sync bytes (0x47) at 188-byte intervals. If sync is lost, it scans forward to find the next valid packet boundary.

**Step 2: Packet Header Parsing**. Each 188-byte packet is parsed to extract the PID, adaptation field, and payload. The adaptation field (if present) contains timing information, discontinuity indicators, and padding.

**Step 3: PSI Table Processing**. Packets with well-known PIDs are routed to PSI table parsers:
- PID 0 → PAT parser: extracts program-to-PMT mappings.
- PMT PIDs → PMT parser: extracts stream PIDs and types.

**Step 4: PES Reassembly**. For data PIDs (those listed in the PMT), payloads are accumulated until a complete PES packet is assembled. The `payload_unit_start_indicator` flag in the transport header signals the beginning of a new PES packet. The parser uses the continuity counter to detect dropped packets.

**Step 5: PES Header Parsing**. Complete PES packets are parsed to extract timing information (PTS/DTS) and the elementary stream data.

### Stream Type Identification

One of the crucial functions provided by picoMpegTS is stream type identification. The PMT lists each elementary stream with a **stream type** code defined in the H.222.0 specification. The library maps these to meaningful constants:

```c
#define PICO_MPEGTS_STREAM_TYPE_H264     0x1B
#define PICO_MPEGTS_STREAM_TYPE_AAC_ADTS 0x0F
```

The demux worker in AVD uses these to route PES packet payloads to the appropriate processing pipelines:

```c
for (size_t i = 0; i < pesPacketCount; i++) {
    picoMpegTSPESPacket pesPacket = pesPackets[i];
    if (picoMpegTSGetPMSStreamByPID(mpegts, pesPacket->head.pid)->streamType
        == PICO_MPEGTS_STREAM_TYPE_H264) {
        totalH264Size += pesPacket->dataLength;
    }
    if (picoMpegTSGetPMSStreamByPID(mpegts, pesPacket->head.pid)->streamType
        == PICO_MPEGTS_STREAM_TYPE_AAC_ADTS) {
        totalAudioSize += pesPacket->dataLength;
    }
}
```

The demuxer also provides helper functions to check if a PES stream ID indicates video or audio content, allowing for additional validation:

```c
if (picoMpegTSIsStreamIDVideo(pesPacket->head.streamId)) { ... }
if (picoMpegTSIsStreamIDAudio(pesPacket->head.streamId)) { ... }
```

### Real-World Challenges

Implementing the MPEG-TS demuxer against real-world streams revealed several challenges:

**Incomplete segments**: Some streams emit segments that begin mid-PES-packet. The demuxer needs to handle the case where the first PES packet in a segment is incomplete.

**Multiple audio/video streams**: Some transport streams carry multiple video or audio PIDs. The PMT parsing needs to correctly enumerate all streams and their types.

**Adaptation fields**: Many real-world streams use adaptation fields for PCR (Program Clock Reference) distribution and stuffing bytes. The parser needs to correctly skip these to find the payload.

**Stream type variants**: Not all AAC audio uses the same stream type code. Some streams use stream type 0x0F (AAC ADTS), while others use 0x11 (AAC LATM). The current implementation focuses on ADTS, which is the more common format in HLS.

### Development Timeline

The picoMpegTS library went through several iterations. Looking at the early libpico commits, the initial implementation provided basic transport packet parsing and PAT/PMT extraction. Later commits added PES reassembly, stream type identification functions, and the zero-copy parsing mode.

The development of picoMpegTS was deeply intertwined with the HLS player integration — bugs in the demuxer would manifest as corrupted video or missing audio in the player, driving iterative improvements. A particularly notable commit added the `picoMpegTSGetPMSStreamByPID` function, which maps PES packet PIDs back to their stream type as declared in the PMT — a crucial capability for routing data to the correct decoder.

---

## Part III: picoH264 — Parsing H.264 Bitstreams

If picoMpegTS is the tool that opens the container, picoH264 is the tool that reads the contents. The H.264/AVC video compression standard is arguably the most complex individual component in the entire pipeline.

![H.264 Bitstream Structure](../../assets/blog/03-vulkan-video/h264_structure.svg)

### Why a Custom H.264 Parser?

It is important to clarify what picoH264 is and is not. As stated in the library's header:

> *"NOTE: It is important to keep in mind that this is NOT A DECODER. This library is only meant to parse H.264 bitstreams and extract NAL units, slices, headers and other metadata from them. Actual decoding of video frames is outside the scope of this library."*

The actual decoding — the computationally intensive process of transforming compressed data into pixel values — is handled by the GPU via Vulkan Video. But the GPU needs to be told *what* to decode. This is where picoH264 comes in. It parses the H.264 bitstream to extract all the metadata that the Vulkan Video decoder needs:

- **Sequence Parameter Sets (SPS)**: Define the overall properties of the video — resolution, chroma format, bit depth, reference frame count, profile/level, and timing information.
- **Picture Parameter Sets (PPS)**: Define properties that can change between pictures — entropy coding mode, transform sizes, deblocking filter settings, and quantization parameters.
- **Slice Headers**: Define properties of individual slices within a frame — slice type (I/P/B), reference picture lists, weighted prediction parameters, and deblocking filter overrides.
- **NAL Unit Headers**: Identify the type and importance of each network abstraction layer unit.

### The H.264 Specification

picoH264 was implemented based on the ITU-T H.264 (V15) (08/2024) specification — all 800+ pages of it. This is one of the most detailed and precise technical specifications in the multimedia domain, and implementing a parser for it is a significant undertaking.

The specification defines the syntax of every element in the bitstream using a tabular format with conditional fields, variable-length codes, and context-dependent parsing rules. A single SPS, for example, contains dozens of fields, many of which are conditionally present based on the values of earlier fields. The PPS contains scaling matrices that are 4x4 or 8x8 arrays of coefficients. Slice headers are even more complex, with reference picture list modification operations and memory management control operations that can dramatically alter the decoder's state.

### Bitstream Structure

An H.264 bitstream is organized into a hierarchy of units:

**Network Abstraction Layer (NAL) Units**: The fundamental packet of the bitstream. Each NAL unit has a 1-byte header containing:
- `forbidden_zero_bit`: Must be 0.
- `nal_ref_idc`: Indicates the importance of the NAL unit for reference picture management.
- `nal_unit_type`: Identifies the type of data in the NAL unit.

NAL unit types include:
- Type 1: Coded slice of a non-IDR picture
- Type 5: Coded slice of an IDR picture (Instantaneous Decoder Refresh — a keyframe)
- Type 6: SEI (Supplemental Enhancement Information) messages
- Type 7: Sequence Parameter Set
- Type 8: Picture Parameter Set
- Type 9: Access Unit Delimiter

NAL units are separated by **start codes** — byte sequences `0x00 0x00 0x01` or `0x00 0x00 0x00 0x01`. The parser needs to scan the bitstream for these markers, handle **emulation prevention bytes** (0x03 inserted after two consecutive zero bytes to prevent false start code detection), and extract the NAL unit payload.

**Exp-Golomb Coding**: Many syntax elements in the bitstream are encoded using Exponential-Golomb codes, a variable-length coding scheme. The parser needs a bit-level reader that can extract unsigned (ue(v)) and signed (se(v)) Exp-Golomb coded values, as well as fixed-length bit fields (u(n)) and flags (u(1)).

### The Buffer Reader

picoH264 implements a dedicated bit-level buffer reader for parsing the compressed syntax elements:

```c
typedef struct {
    const uint8_t *data;
    size_t size;
    size_t bitPosition;
} picoH264BufferReader;
```

This reader provides functions for:
- Reading fixed-length unsigned integers: `picoH264BufferReaderU(reader, numBits)`
- Reading Exp-Golomb coded unsigned integers: `picoH264BufferReaderUE(reader)`
- Reading Exp-Golomb coded signed integers: `picoH264BufferReaderSE(reader)`
- Checking for remaining RBSP data: `picoH264BufferReaderMoreRBSPData(reader)`

The Exp-Golomb decoding algorithm works by first counting the number of leading zero bits, then reading that many additional bits to form the value. For unsigned values:

$$x = 2^{leadingZeroBits} - 1 + \text{read\_bits}(leadingZeroBits)$$

For signed values, the unsigned value is converted using:

$$\text{se} = (-1)^{x+1} \cdot \lceil x/2 \rceil$$

### Parsing the SPS

The Sequence Parameter Set is the single most important structure in the bitstream. It defines:

- **Profile and Level**: `profile_idc` and `level_idc` determine the capabilities required to decode the stream. The parser handles profiles from Baseline (66) through High (100) and levels from 1.0 through 6.2.

- **Chroma Format**: `chroma_format_idc` specifies the chroma subsampling scheme. Most broadcast and streaming content uses 4:2:0 (value 1), where the chroma resolution is half the luma resolution in both dimensions. The Vulkan Video decoder currently only supports 4:2:0.

- **Resolution**: The actual video dimensions are encoded somewhat indirectly:
  ```
  width = (pic_width_in_mbs_minus1 + 1) * 16
  height = (2 - frame_mbs_only_flag) * (pic_height_in_map_units_minus1 + 1) * 16
  ```
  Frame cropping offsets are then applied to get the actual display resolution from the padded/aligned resolution.

- **Reference Frame Count**: `max_num_ref_frames` determines how many reference frames the decoder needs to keep in its DPB (Decoded Picture Buffer).

- **Picture Order Count Type**: `pic_order_cnt_type` (0, 1, or 2) determines the algorithm used to compute the display order of frames. This is crucial for B-frame reordering.

- **VUI Parameters**: The Video Usability Information extension contains timing info (`num_units_in_tick`, `time_scale`), aspect ratio, color space descriptors, and more. These are essential for determining framerate and correct color reproduction.

The SPS parsing in AVD extracts all of this information and converts it to Vulkan's `StdVideoH264SequenceParameterSet` structure for submission to the video decode session:

```c
vSps->profile_idc = (StdVideoH264ProfileIdc)sps->profileIdc;
vSps->level_idc = ...; // Mapped through a lookup table
vSps->chroma_format_idc = STD_VIDEO_H264_CHROMA_FORMAT_IDC_420;
vSps->seq_parameter_set_id = sps->seqParameterSetId;
vSps->bit_depth_luma_minus8 = sps->bitDepthLumaMinus8;
vSps->log2_max_frame_num_minus4 = (uint8_t)sps->log2MaxFrameNumMinus4;
vSps->pic_order_cnt_type = (StdVideoH264PocType)sps->picOrderCntType;
vSps->max_num_ref_frames = sps->maxNumRefFrames;
vSps->pic_width_in_mbs_minus1 = (uint32_t)sps->picWidthInMbsMinus1;
vSps->pic_height_in_map_units_minus1 = (uint32_t)sps->picHeightInMapUnitsMinus1;
```

### Parsing the PPS

The Picture Parameter Set is simpler than the SPS but still contains important information:

- **Entropy Coding Mode**: `entropy_coding_mode_flag` selects between CAVLC (0) and CABAC (1). CABAC provides better compression but is more computationally expensive to decode.

- **Weighted Prediction**: `weighted_pred_flag` and `weighted_bipred_idc` control how reference pictures are weighted during prediction.

- **Deblocking Filter**: `deblocking_filter_control_present_flag` enables per-slice deblocking filter configuration.

- **Scaling Lists**: `pic_scaling_matrix_present_flag` indicates whether custom quantization scaling matrices are defined. The parser handles both 4x4 and 8x8 scaling lists.

- **Transform Mode**: `transform_8x8_mode_flag` enables 8x8 integer transforms in addition to the default 4x4 transforms.

### Parsing Slice Headers

Slice headers are the most complex per-frame structures. A slice header contains:

- **Slice Type**: I (intra), P (predictive), B (bi-predictive), SI, or SP.
- **Frame Number**: `frame_num` identifies the frame in decoding order.
- **IDR Picture ID**: For IDR frames, this identifies which IDR this is (useful for error recovery).
- **Picture Order Count LSB**: For POC type 0, this provides the least significant bits of the picture order count.
- **Reference Picture List Modifications**: Instructions for reordering the default reference picture lists.
- **Decoded Reference Picture Marking**: Instructions for managing the DPB — marking frames as "used for reference" or "unused", or assigning long-term reference indices.
- **Quantization Parameter**: `slice_qp_delta` adjusts the picture-level QP for this slice.

### Picture Order Count (POC) Calculation

One of the trickiest parts of the H.264 parser is computing the Picture Order Count for each frame. The POC determines the display order of frames, which can differ significantly from the decoding order when B-frames are used.

The H.264 specification defines three POC calculation methods, selected by `pic_order_cnt_type` in the SPS:

**POC Type 0**: Uses `pic_order_cnt_lsb` from the slice header combined with a running MSB counter. The algorithm detects wrap-around based on the difference between the current and previous LSB values:

```c
if ((sliceHeader->picOrderCntLsb < prevPicOrderCntLsb) &&
    ((prevPicOrderCntLsb - sliceHeader->picOrderCntLsb) >= (maxPicOrderCntLsb / 2))) {
    picOrderCntMsb = prevPicOrderCntMsb + maxPicOrderCntLsb; // wrapped forward
} else if ((sliceHeader->picOrderCntLsb > prevPicOrderCntLsb) &&
           ((sliceHeader->picOrderCntLsb - prevPicOrderCntLsb) > (maxPicOrderCntLsb / 2))) {
    picOrderCntMsb = prevPicOrderCntMsb - maxPicOrderCntLsb; // wrapped backward
} else {
    picOrderCntMsb = prevPicOrderCntMsb; // no wrap
}
```

This directly implements equations 8-3 through 8-5 from the specification.

**POC Type 1**: Uses `frame_num` and an offset table defined in the SPS. The algorithm involves computing an absolute frame number, dividing it into cycles, and accumulating offsets. This is the most complex POC type and is rarely seen in practice.

**POC Type 2**: Uses `frame_num` directly. The POC is simply `2 * (frameNumOffset + frame_num)` for reference pictures, and `2 * (frameNumOffset + frame_num) - 1` for non-reference pictures.

All three types also need to handle the MMCO (Memory Management Control Operation) 5, which resets the POC state. This operation is signaled in the decoded reference picture marking syntax.

### Display Order Calculation

After computing POC values for all frames in a chunk, the display order is determined by sorting frames by their POC:

```c
static bool __avdH264VideoChunkCalculateDisplayOrder(AVD_H264VideoChunk *chunk)
{
    // Create index-POC pairs
    for (size_t i = 0; i < frameCount; i++) {
        pairs[i].poc = frameInfo->pictureOrderCount;
        pairs[i].index = i;
    }

    // Sort by POC
    qsort(pairs, frameCount, sizeof(pair), pocCompare);

    // Assign display order based on sorted position
    for (size_t displayOrder = 0; displayOrder < frameCount; displayOrder++) {
        frameInfo->chunkDisplayOrder = (uint32_t)displayOrder;
    }
}
```

This reordering is essential for correct video playback. Without it, B-frames would be displayed in the wrong order, causing visible artifacts.

### Development of picoH264

The development of picoH264 was by far the most extensive of all the pico libraries used in this project. The git history of libpico reveals a methodical, bottom-up development approach:

1. **Initial NAL unit structures**: The earliest commits define the basic `picoH264NALUnitHeader` structure and NAL unit type enumeration with string conversion functions.

2. **NAL unit detection and parsing**: Implementation of `picoH264FindNextNALUnit` for scanning bitstreams and `picoH264ParseNALUnit` for extracting payloads with emulation prevention byte removal.

3. **Buffer reader**: Implementation of the bit-level reader with Exp-Golomb coding support.

4. **SPS parsing**: A multi-commit effort adding support for the base SPS, VUI parameters, HRD parameters, and scaling lists.

5. **PPS parsing**: Added with scaling matrix support.

6. **Slice header parsing**: The most complex parsing step, implemented over several commits as different slice header features were needed.

7. **SPS extensions**: Support for SVC, MVC, and 3D extensions (for completeness, though not used in this project).

8. **SEI message parsing**: Added for supplemental enhancement information.

9. **Bitstream creation/destruction helpers**: Utility functions for creating bitstream readers from buffers and files.

10. **Slice type parsing**: A dedicated function to quickly determine the slice type without fully parsing the header.

11. **Maximum SPS/PPS counts**: Constants `PICO_H264_MAX_SPS_COUNT` and `PICO_H264_MAX_PPS_COUNT` added for array sizing.

Each commit represents a carefully tested increment. The library was continuously tested against real H.264 bitstreams extracted from HLS segments, with bugs fixed as they were discovered. The most challenging edge cases involved:

- **Multi-slice frames**: Some encoders emit multiple slices per frame, each with their own slice header.
- **Parameter set updates**: Live streams can change SPS/PPS mid-stream, requiring the parser to detect and handle updates without losing state.
- **Non-IDR I-frames**: Some streams use I-frames that are not flagged as IDR (Instantaneous Decoder Refresh). The parser needed to detect these by examining the slice type, not just the NAL unit type.

---

## Part IV: picoAudio — Cross-Platform Audio Decoding

Video without audio is a silent movie. The fourth library in the chain, picoAudio, handles decoding audio data from AAC-ADTS format to raw PCM samples for playback.

### Design Philosophy

Unlike the other pico media libraries, picoAudio does not implement codec algorithms from scratch. AAC (Advanced Audio Coding) is a patent-encumbered codec, and implementing a decoder from scratch would be an enormous undertaking with questionable legal status. Instead, picoAudio takes a pragmatic approach: it uses platform-native APIs for the actual decoding work.

On Windows, picoAudio uses **Media Foundation** via the `IMFSourceReader` COM interface. On macOS, it uses **AudioToolbox** via the `ExtAudioFile` API. This approach provides high-quality, hardware-accelerated audio decoding on all supported platforms while keeping the library's API clean and simple.

### The picoAudio API

The library provides a straightforward API for decoding audio:

```c
picoAudioDecoder decoder = picoAudioDecoderCreate();

picoAudioDecoderConfigureSourceReader(decoder, ...);
picoAudioDecoderOpen(decoder, filePath);

// Read decoded PCM samples
picoAudioDecoderReadPCM(decoder, buffer, bufferSize, &samplesRead);

picoAudioDecoderDestroy(decoder);
```

The decoder supports various output formats (16-bit integer, 32-bit float) and can handle both file-based and buffer-based inputs. For the HLS player, buffer-based input is used since the AAC data comes from MPEG-TS demuxing rather than from files on disk.

### Integration with the Streaming Audio Player

In AVD, the streaming audio player (`avd_audio_streaming_player`) manages a ring buffer of decoded audio chunks. When a new HLS segment is demuxed, the AAC data is fed to the streaming player:

```c
avdAudioStreamingPlayerAddChunk(&context->audioPlayer, avData.aacBuffer, avData.aacSize);
```

The streaming player decodes the AAC data using picoAudio and buffers the resulting PCM samples. A PortAudio callback function is registered to feed audio data to the operating system's audio output:

```c
static int audioCallback(
    const void *input, void *output,
    unsigned long frameCount,
    const PaStreamCallbackTimeInfo *timeInfo,
    PaStreamCallbackFlags statusFlags,
    void *userData)
{
    // Copy PCM samples from the ring buffer to the output buffer
    // Handle buffer underruns gracefully
}
```

### Audio Device Management

The audio subsystem in AVD is built on [PortAudio](https://github.com/PortAudio/portaudio), a cross-platform audio I/O library. The development of the audio system is visible in the git history:

1. **Initial attempt with OpenAL**: The first audio implementation used OpenAL Soft. Several commits show the integration of OpenAL, buffer management, and source linking.

2. **Switch to PortAudio**: A pivotal commit replaced OpenAL with PortAudio: *"feat: replace OpenAL with PortAudio for audio handling and remove unused audio code"*. This was motivated by PortAudio's simpler streaming model, which better matched the needs of live audio playback.

3. **Streaming player**: The streaming audio player was implemented to handle the continuous, segment-based audio delivery model of HLS: *"feat: implement audio streaming player with buffer management and chunk handling"*.

4. **Volume control**: Distance-based volume attenuation was added later to create a spatial audio effect in the 3D scene.

### Volume and Spatial Audio

The HLS player creates a simple spatial audio effect by attenuating volume based on the camera's distance from each TV:

```c
float distanceFromCamera = avdVec3Length(
    avdVec3Subtract(sourcePositions[i], scene->cameraPosition));
source->player.audioPlayer.volume = 10.0f / (distanceFromCamera * distanceFromCamera);
```

This inverse-square attenuation law matches the physical behavior of sound intensity, creating an intuitive experience where TVs closer to the camera are louder than those farther away.

---

## Part V: The AVD Vulkan Video Infrastructure

With all the parsing and demuxing done, we reach the core of the system: actually decoding the video using the GPU. The Vulkan Video extensions (`VK_KHR_video_queue`, `VK_KHR_video_decode_queue`, `VK_KHR_video_decode_h264`) provide hardware-accelerated video decoding, and building a complete decoder on top of them is a significant engineering effort.

![Vulkan Video H.264 Decode Pipeline](../../assets/blog/03-vulkan-video/vulkan_video_decode.svg)

### Vulkan Video: An Overview

The Vulkan Video extensions were introduced to bring video encode and decode operations into the Vulkan API ecosystem. Unlike traditional video decoding APIs (DXVA, VAAPI, VideoToolbox), Vulkan Video integrates video processing directly with the graphics API, enabling:

- Zero-copy transfer of decoded frames to graphics pipelines.
- Unified memory management across video and graphics operations.
- Explicit synchronization between video and graphics workloads.
- Cross-platform hardware video acceleration with a single API.

The key concepts in Vulkan Video are:

**Video Sessions**: Analogous to a decoder instance. You create a video session with a specific codec, profile, and maximum resolution. The session requires GPU memory allocations.

**Video Session Parameters**: Contain the codec-specific metadata needed for decoding — SPS and PPS for H.264. These can be updated when the stream parameters change.

**Video Decode Operations**: Submitted as commands in a command buffer, similar to draw or compute commands. Each decode operation takes a bitstream buffer, reference pictures, and produces a decoded picture.

**Decoded Picture Buffer (DPB)**: A set of images that hold decoded reference frames. The decoder reads from and writes to DPB slots as it processes frames.

### Device Setup and Capability Queries

Before any video decoding can happen, the Vulkan device must be set up with video queue support. AVD's device initialization code queries for video decode capabilities:

```c
VkVideoDecodeH264ProfileInfoKHR h264DecodeProfileInfo = {
    .sType = VK_STRUCTURE_TYPE_VIDEO_DECODE_H264_PROFILE_INFO_KHR,
    .stdProfileIdc = STD_VIDEO_H264_PROFILE_IDC_HIGH,
    .pictureLayout =
        VK_VIDEO_DECODE_H264_PICTURE_LAYOUT_INTERLACED_INTERLEAVED_LINES_BIT_KHR,
};

VkVideoProfileInfoKHR videoProfileInfo = {
    .sType = VK_STRUCTURE_TYPE_VIDEO_PROFILE_INFO_KHR,
    .videoCodecOperation = VK_VIDEO_CODEC_OPERATION_DECODE_H264_BIT_KHR,
    .lumaBitDepth = VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR,
    .chromaBitDepth = VK_VIDEO_COMPONENT_BIT_DEPTH_8_BIT_KHR,
    .chromaSubsampling = VK_VIDEO_CHROMA_SUBSAMPLING_420_BIT_KHR,
    .pNext = &h264DecodeProfileInfo,
};
```

These structures are used to query the device's video decode capabilities (maximum resolution, supported levels, DPB requirements) and to create video decode queues.

The capability query returns information about:
- Maximum coded extent (resolution)
- Maximum number of DPB slots
- Maximum number of active reference pictures
- Minimum bitstream buffer alignment requirements
- Whether DPB and output can coincide (share the same image) or must be distinct

### Creating the Video Session

The video session is the fundamental decoder object. Creating one involves:

1. **Allocating GPU memory**: Unlike most Vulkan objects, video sessions require explicit memory binding. The implementation queries memory requirements and allocates memory for each requirement:

```c
vkGetVideoSessionMemoryRequirementsKHR(device, session, &count, requirements);

for (uint32_t i = 0; i < count; i++) {
    VkMemoryAllocateInfo allocInfo = {
        .allocationSize = requirements[i].memoryRequirements.size,
        .memoryTypeIndex = findMemoryType(requirements[i].memoryRequirements.memoryTypeBits, 0),
    };
    vkAllocateMemory(device, &allocInfo, NULL, &memory[i]);
}

vkBindVideoSessionMemoryKHR(device, session, count, bindInfos);
```

2. **Creating session parameters**: The SPS and PPS parsed by picoH264 are converted to Vulkan's `StdVideoH264SequenceParameterSet` and `StdVideoH264PictureParameterSet` structures and bundled into a `VkVideoSessionParametersKHR` object.

This conversion is remarkably detailed. Every field from picoH264's SPS structure must be mapped to the corresponding field in Vulkan's structure — constraint flags, VUI parameters, HRD parameters, and all. The PPS conversion similarly maps entropy coding mode, transform mode, scaling lists, and deblocking filter parameters.

### The Decoded Picture Buffer (DPB)

The DPB is central to H.264 decoding. It stores reference frames that other frames depend on for motion-compensated prediction. In Vulkan Video, the DPB is implemented as a layered image:

```c
AVD_VulkanImageCreateInfo dpbImageInfo = {
    .width = paddedWidth,
    .height = paddedHeight,
    .format = VK_FORMAT_G8_B8R8_2PLANE_420_UNORM,
    .usage = VK_IMAGE_USAGE_VIDEO_DECODE_DPB_BIT_KHR
           | VK_IMAGE_USAGE_VIDEO_DECODE_DST_BIT_KHR
           | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
    .arrayLayers = numDPBSlots,
};
```

Each array layer represents one DPB slot. The number of slots is determined by the SPS's `max_num_ref_frames` field plus one (for the currently decoding frame).

The format `VK_FORMAT_G8_B8R8_2PLANE_420_UNORM` is a multi-planar format: the first plane contains 8-bit luma (Y) samples, and the second plane contains interleaved 8-bit chroma (Cb, Cr) samples at half resolution in both dimensions.

### DPB Coincide vs. Distinct Mode

Vulkan Video defines two modes for how the DPB interacts with the decode output:

- **Coincide mode**: The decode output goes directly into a DPB slot. The same image serves as both DPB reference and output. This is more memory-efficient.
- **Distinct mode**: The decode output goes to a separate image, and the DPB references are separate. This provides more flexibility but uses more memory.

The implementation checks the device capabilities and chooses accordingly:

```c
dpb->decodeOutputCoincideSupported = (capabilities.flags &
    VK_VIDEO_DECODE_CAPABILITY_DPB_AND_OUTPUT_COINCIDE_BIT_KHR) != 0;
dpb->decodeOutputDistinctSupported = (capabilities.flags &
    VK_VIDEO_DECODE_CAPABILITY_DPB_AND_OUTPUT_DISTINCT_BIT_KHR) != 0;
```

### Decoding a Frame

The actual decode operation is a complex sequence of Vulkan commands:

**Step 1: Prepare the command buffer**

```c
vkResetCommandPool(device, videoDecodeCommandPool, 0);
vkBeginCommandBuffer(commandBuffer, &beginInfo);
```

**Step 2: Transition DPB images to the correct layout**

The current DPB slot needs to be in `VK_IMAGE_LAYOUT_VIDEO_DECODE_DPB_KHR` for decoding:

```c
avdVulkanVideoDecodeDPBTransitionImageLayout(
    vulkan, &dpb,
    currentDPBSlotIndex,
    VK_IMAGE_LAYOUT_VIDEO_DECODE_DPB_KHR,
    commandBuffer);
```

**Step 3: Set up reference slot information**

Each reference frame needs a `VkVideoReferenceSlotInfoKHR` structure pointing to its DPB slot, along with H.264-specific reference information (frame number, POC):

```c
for (uint32_t i = 0; i < numDPBSlots; i++) {
    referenceSlotInfos[i] = (VkVideoReferenceSlotInfoKHR){
        .sType = VK_STRUCTURE_TYPE_VIDEO_REFERENCE_SLOT_INFO_KHR,
        .pPictureResource = &referenceSlotPictures[i],
        .slotIndex = i,
        .pNext = &dpbSlotsH264[i],
    };

    referenceInfosH264[i] = (StdVideoDecodeH264ReferenceInfo){
        .FrameNum = chunk->referenceInfo[i].frameNum,
        .PicOrderCnt[0] = chunk->referenceInfo[i].picOrderCount,
        .PicOrderCnt[1] = chunk->referenceInfo[i].picOrderCount,
    };
}
```

**Step 4: Begin video coding scope**

```c
VkVideoBeginCodingInfoKHR beginInfo = {
    .videoSession = session,
    .videoSessionParameters = sessionParameters,
    .referenceSlotCount = referencesCount + 1,
    .pReferenceSlots = referenceSlots,
};
vkCmdBeginVideoCodingKHR(commandBuffer, &beginInfo);
```

**Step 5: Reset the session (if needed)**

After creating or recreating session parameters, the session must be reset:

```c
if (video->needsReset) {
    VkVideoCodingControlInfoKHR resetInfo = {
        .sType = VK_STRUCTURE_TYPE_VIDEO_CODING_CONTROL_INFO_KHR,
        .flags = VK_VIDEO_CODING_CONTROL_RESET_BIT_KHR,
    };
    vkCmdControlVideoCodingKHR(commandBuffer, &resetInfo);
}
```

**Step 6: Issue the decode command**

```c
VkVideoDecodeInfoKHR decodeInfo = {
    .srcBuffer = bitstreamBuffer.buffer,
    .srcBufferOffset = frame->offset,
    .srcBufferRange = alignedSize,
    .referenceSlotCount = referencesCount,
    .pReferenceSlots = referenceSlots,
    .pSetupReferenceSlot = &currentSlotInfo,
    .dstPictureResource = dstPictureResource,
    .pNext = &pictureInfoH264,
};
vkCmdDecodeVideoKHR(commandBuffer, &decodeInfo);
```

**Step 7: End video coding scope**

```c
vkCmdEndVideoCodingKHR(commandBuffer, &endInfo);
```

**Step 8: Copy decoded frame to output**

The decoded frame is copied from the DPB image to a dedicated output image that can be sampled in graphics shaders. This involves transitioning the DPB image to `VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL`, the output image to `VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL`, performing a multi-plane image copy (luma and chroma planes are copied separately), and then transitioning the output image to `VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL`.

The copy handles the two planes separately because they have different resolutions:

```c
// Luma plane (full resolution)
VkImageCopy copyRegion = {
    .extent = { paddedWidth, paddedHeight, 1 },
    .srcSubresource = { .aspectMask = VK_IMAGE_ASPECT_PLANE_0_BIT, ... },
    .dstSubresource = { .aspectMask = VK_IMAGE_ASPECT_PLANE_0_BIT, ... },
};
vkCmdCopyImage(commandBuffer, srcImage, ..., dstImage, ..., 1, &copyRegion);

// Chroma plane (half resolution)
copyRegion.extent = { paddedWidth / 2, paddedHeight / 2, 1 };
copyRegion.srcSubresource.aspectMask = VK_IMAGE_ASPECT_PLANE_1_BIT;
copyRegion.dstSubresource.aspectMask = VK_IMAGE_ASPECT_PLANE_1_BIT;
vkCmdCopyImage(commandBuffer, srcImage, ..., dstImage, ..., 1, &copyRegion);
```

**Step 9: Submit and wait**

```c
vkEndCommandBuffer(commandBuffer);
vkQueueSubmit(videoDecodeQueue, 1, &submitInfo, decodeFence);
vkWaitForFences(device, 1, &decodeFence, VK_TRUE, UINT64_MAX);
```

### Reference Frame Management

After decoding a frame, the decoder needs to update its reference picture list. If the decoded frame is a reference frame (`nal_ref_idc > 0`), it is added to the reference list:

```c
if (frame->nalRefIdc > 0 && video->h264Video->numDPBSlots > 1) {
    chunk->references[chunk->referenceSlotIndex++] = chunk->currentDPBSlotIndex;
    chunk->referencesCount = max(chunk->referencesCount, chunk->referenceSlotIndex);
    chunk->currentDPBSlotIndex = (chunk->currentDPBSlotIndex + 1) % video->h264Video->numDPBSlots;
    chunk->referenceSlotIndex = chunk->referenceSlotIndex % (video->h264Video->numDPBSlots - 1);
}
```

For IDR frames, the reference list is completely reset, as IDR frames by definition do not reference any previous frames.

### Decoded Frame Management

The decoder maintains a circular buffer of `AVD_VULKAN_VIDEO_MAX_DECODED_FRAMES` (8) decoded frames. Each frame has a status:

- `FREE`: Available for decoding.
- `PROCESSING`: Currently being decoded (reserved for future async decoding).
- `READY`: Decoded and waiting to be displayed.
- `ACQUIRED`: Currently being displayed.

When looking for a frame to decode into, the decoder first searches for a free slot. If none are available, it looks for the oldest outdated frame (one with a display order earlier than the currently acquired frame) that can be recycled:

```c
for (size_t i = 0; i < MAX_DECODED_FRAMES; i++) {
    if (decodedFrames[i].status == STATUS_FREE) {
        decodedFrame = &decodedFrames[i];
        break;
    }
    bool isOutdated = decodedFrames[i].chunkDisplayOrder < acquiredFrameDisplayOrder;
    bool frameAllowed = (isOutdated || allowOverrideUnacquiredFrames)
                     && decodedFrames[i].status != STATUS_ACQUIRED;
    if (frameAllowed && decodedFrames[i].chunkDisplayOrder < oldestFrameOrder) {
        oldestFrame = &decodedFrames[i];
        oldestFrameOrder = decodedFrames[i].chunkDisplayOrder;
    }
}
```

When the application needs a frame for display, it calls `avdVulkanVideoDecoderTryAcquireFrame` with the current playback time. The function finds a decoded frame whose timestamp range covers the current time and returns it:

```c
bool isFrameInTime(AVD_VulkanVideoDecoder *video,
                   AVD_VulkanVideoDecodedFrame *frame,
                   float targetTimeSeconds)
{
    float frameStartTime = frame->timestampSeconds;
    float frameEndTime = frameStartTime + video->h264Video->frameDurationSeconds;
    return (targetTimeSeconds >= frameStartTime && targetTimeSeconds < frameEndTime);
}
```

### YCbCr Subresource Creation

The decoded frame images use a multi-planar YCbCr format. To sample them in a graphics shader, the implementation creates separate image views for the luma and chroma planes:

```c
avdVulkanImageYCbCrSubresourceCreate(
    vulkan,
    &frame->image,
    (VkImageSubresourceRange){
        .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT,
        .baseMipLevel = 0,
        .levelCount = 1,
        .baseArrayLayer = 0,
        .layerCount = 1,
    },
    true, // raw mode: separate luma and chroma views
    &frame->ycbcrSubresource);
```

This creates two separate `VkImageView` and `VkSampler` pairs — one for the luma plane (`PLANE_0`) and one for the chroma plane (`PLANE_1`). These are bound to the bindless descriptor set for shader access.

### Development History of Vulkan Video in AVD

The git history reveals a painstaking, step-by-step construction of the video decode pipeline:

1. **Initial device setup** (*"feat: setup both video encode and decode in vulkan device setup"*): Adding video queue family discovery and command pool creation.

2. **Video session management** (*"feat: add Vulkan video session management functionality"*): Creating and destroying video sessions with proper memory management.

3. **Profile and capability queries** (*"feat: add H.264 video decode and encode profile info functions"*): Querying device capabilities for H.264 decode support.

4. **DPB implementation** (*"feat: initial vulkan video dpb implementation"*): Creating DPB images with the correct format, usage flags, and multi-layer layout.

5. **Bitstream buffer preparation** (*"feat: setup preparation of bitstream buffers for video chunks"*): Aligned buffer management for feeding compressed data to the decoder.

6. **Session parameter management** (*"feat: setup vulkan video session parameters management"*): Converting picoH264's SPS/PPS to Vulkan's `StdVideo` structures.

7. **Basic decoding** (*"feat: basic video decoding"*): The first successful decode of a video frame.

8. **Frame copying** (*"feat: implement frame copying logic in video decoder for improved performance"*): Copying decoded frames from DPB to output images.

9. **Reference frame management** (*"fix: correctly handle reference count fixing I+P frame videos"*, *"fix: reference slot index dual updation (fixing B frames)"*): Extensive debugging of reference picture management for different frame types.

10. **YCbCr support** (*"feat: add YCbCr subresource support and sampler configuration"*): Creating proper image views for multi-planar sampling.

11. **Color conversion** (*"feat: integrate YUV to RGB conversion in fragment shader"*): Implementing color space conversion in HLSL.

The reference frame management was particularly challenging. Multiple commits address different aspects: fixing I+P frame sequencing, fixing B-frame reference list construction, correcting the DPB slot cycling logic, and handling IDR frame resets. Each bug manifested as visual corruption in specific frames, requiring careful analysis of the H.264 bitstream and the decoder's internal state.

---

## Part VI: The HLS Player Scene — Tying It All Together

With all the individual components built, the HLS player scene orchestrates them into a unified system. The scene architecture follows AVD's plugin-based model: it implements `init`, `load`, `update`, `render`, `destroy`, and `inputEvent` callbacks.

![System Architecture Overview](../../assets/blog/03-vulkan-video/architecture_overview.svg)

### Scene Structure

The scene manages up to `AVD_SCENE_HLS_PLAYER_MAX_SOURCES` (4) independent HLS sources simultaneously. Each source has:

```c
typedef struct {
    char url[1024];
    bool active;
    float refreshIntervalMs;
    float lastRefreshed;
    float videoStartTime;
    size_t currentlyPlayingSegmentId;
    bool firstBound;
    AVD_SceneHLSPlayerContext player;
} AVD_SceneHLSPlayerSource;
```

The scene also maintains shared resources:

```c
typedef struct AVD_SceneHLSPlayer {
    // ... scene type, matrices, text, pipeline ...

    AVD_SceneHLSPlayerSource sources[4];
    uint32_t sourceCount;
    uint32_t sourcesHash;

    AVD_HLSURLPool urlPool;
    AVD_HLSMediaCache mediaCache;
    AVD_HLSWorkerPool workerPool;

    AVD_Vector3 cameraPosition;
    AVD_Vector3 cameraDirection;
    float cameraYaw;
    float cameraPitch;

    bool isSupported;
} AVD_SceneHLSPlayer;
```

### Source Loading

Sources are loaded from a text file (`assets/scene_hls_player/sources.txt`) where each line is an HLS playlist URL:

```
https://example.com/stream1/playlist.m3u8
https://example.com/stream2/playlist.m3u8
https://example.com/stream3/playlist.m3u8
https://example.com/stream4/playlist.m3u8
```

The loading function validates each URL, assigns it to a source slot, and computes a hash of the entire source set. This hash is used throughout the pipeline to detect stale data when sources are changed.

A particularly nice feature is drag-and-drop support: users can drag a text file containing source URLs directly onto the application window to switch streams:

```c
if (event->type == AVD_INPUT_EVENT_DRAG_N_DROP) {
    if (event->dragNDrop.count > 0) {
        avdHLSWorkerPoolFlush(&hlsPlayer->workerPool);
        avdHLSURLPoolClear(&hlsPlayer->urlPool);
        __avdSceneHLSPlayerLoadSourcesFromPath(appState, hlsPlayer, event->dragNDrop.paths[0]);
    }
}
```

### Initialization

Scene initialization creates the graphics pipeline, the worker pool, the URL pool, the media cache, and loads initial sources:

```c
bool avdSceneHLSPlayerInit(struct AVD_AppState *appState, union AVD_Scene *scene)
{
    // Check hardware support
    hlsPlayer->isSupported = appState->vulkan.supportedFeatures.videoDecode;

    // Create text renderers for title and info
    avdRenderableTextCreate(&hlsPlayer->title, ...);
    avdRenderableTextCreate(&hlsPlayer->info, ...);

    // Setup camera
    hlsPlayer->cameraPosition = avdVec3(0.0f, 15.0f, 60.0f);
    hlsPlayer->cameraYaw = AVD_PI; // looking toward -Z

    // Create graphics pipeline with the HLS player shaders
    avdPipelineUtilsCreateGraphicsLayoutAndPipeline(
        &hlsPlayer->pipelineLayout,
        &hlsPlayer->pipeline,
        "HLSPlayerVert", "HLSPlayerFrag",
        ...);

    // Load sources
    __avdSceneHLSPlayerLoadSourcesFromPath(appState, hlsPlayer, "assets/scene_hls_player/sources.txt");

    // Initialize worker pool
    avdHLSURLPoolInit(&hlsPlayer->urlPool);
    avdHLSMediaCacheInit(&hlsPlayer->mediaCache);
    avdHLSWorkerPoolInit(&hlsPlayer->workerPool, &hlsPlayer->urlPool, &hlsPlayer->mediaCache, hlsPlayer);
}
```

### The Update Loop

The update function is the heart of the scene. Called every frame, it orchestrates the entire pipeline:

```c
bool avdSceneHLSPlayerUpdate(struct AVD_AppState *appState, union AVD_Scene *scene)
{
    // 1. Update sources — trigger playlist refreshes on schedule
    __avdSceneHLSPlayerUpdateSources(appState, hlsPlayer);

    // 2. Receive ready segments from worker threads
    __avdSceneHLSPlayerReceiveReadySegments(appState, hlsPlayer);

    // 3. Update player contexts — decode frames, manage audio
    __avdSceneHLSPlayerUpdateContexts(appState, hlsPlayer);

    // 4. Handle camera movement
    // W/S for forward/back, A/D for strafe, Q/E for up/down
    // Mouse drag for look, scroll for zoom
}
```

**Source Updates**: Each source has a `refreshIntervalMs` timer. When the timer expires, a new playlist fetch is enqueued to the worker pool. The refresh interval is dynamically adjusted based on segment duration — shorter segments mean more frequent refreshes.

**Receiving Ready Segments**: The main thread polls the worker pool's ready channel for completed segments. Each received segment is validated (its sources hash is checked against the current hash to detect stale data), and then passed to the appropriate player context.

**Context Updates**: For each source, the player context handles video decoding and audio playback. If the current segment's duration has elapsed, the context switches to the next segment from the segment store. If no frames are available for the current time, new video data is decoded.

### Frame Binding

When a new decoded frame is acquired, it is bound to the bindless descriptor set for shader access:

```c
if (avdSceneHLSPlayerContextTryAcquireFrame(&source->player, &frame)) {
    VkWriteDescriptorSet descriptorWrite[2] = {
        {
            .dstSet = appState->vulkan.bindlessDescriptorSet,
            .dstBinding = AVD_VULKAN_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
            .dstArrayElement = i * 2 + 0, // luma
            .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
            .pImageInfo = &frame->ycbcrSubresource.raw.luma.descriptorImageInfo,
        },
        {
            .dstSet = appState->vulkan.bindlessDescriptorSet,
            .dstBinding = AVD_VULKAN_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
            .dstArrayElement = i * 2 + 1, // chroma
            .descriptorType = VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER,
            .pImageInfo = &frame->ycbcrSubresource.raw.chroma.descriptorImageInfo,
        },
    };
    vkUpdateDescriptorSets(device, 2, descriptorWrite, 0, NULL);
}
```

Each source uses two descriptor slots — one for luma and one for chroma. With four sources, this uses descriptors 0-7 in the bindless set.

### Player Context

The `AVD_SceneHLSPlayerContext` manages the lifecycle of a single stream:

```c
typedef struct {
    bool initialized;
    size_t sourceIndex;

    AVD_VulkanVideoDecoder videoPlayer;
    AVD_AudioStreamingPlayer audioPlayer;

    picoStream videoDataStream;
    AVD_HLSSegmentStore segmentStore;

    AVD_HLSSegmentAVData currentSegment;
    float currentSegmentPlayTime;
    float currentSegmentStartTime;
    float currentSegmentTargetFramerate;

    AVD_VulkanVideoDecodedFrame *currentFrame;
} AVD_SceneHLSPlayerContext;
```

The context uses a custom stream implementation (`avdHLSStreamCreate`) that supports appending new data as segments are downloaded. This appendable stream is critical for feeding continuous video data to the H.264 parser and Vulkan decoder.

### Segment Store

The segment store is a bounded buffer that holds downloaded but not-yet-played segments:

```c
#define AVD_SCENE_HLS_PLAYER_MAX_LOADED_SEGMENTS 16
```

When a segment is fully demuxed and its audio/video data is ready, it is added to the segment store. When the player needs to switch to the next segment, it queries the store for the segment with the next sequential ID.

The store uses an LRU-like eviction strategy — when full, segments are sorted to find the one that should be replaced. It also provides functions to check if a segment is already loaded (to avoid redundant downloads) and to count loaded segments (for buffer health monitoring).

### The Custom HLS Stream

The custom stream implementation is a particularly clever piece of engineering. It implements picoStream's callback interface with a growable, appendable buffer:

```c
typedef struct {
    uint8_t *buffer;
    size_t capacity;
    size_t readHead;
    size_t writeHead;
    int64_t headOffset;
} AVD_ScenesHLSStream;
```

The `headOffset` tracks the absolute byte position of the buffer's start in the overall stream. As new data is appended and old data is consumed, the buffer compacts itself, moving unconsumed data to the beginning and updating the offset. This allows the stream to handle arbitrarily long video streams without unbounded memory growth, while still supporting the seek operations that the H.264 parser requires (within a limited window).

The stream also maintains a seek buffer (`AVD_HLS_STREAM_SEEK_BUFFER_SIZE`) — a small amount of already-consumed data that is kept to allow backward seeks, which the parser occasionally needs when peeking at upcoming NAL units.

```c
bool avdHLSStreamAppendData(picoStream stream, const uint8_t *data, size_t dataSize)
{
    // Calculate available space
    size_t currentSize = hlsStream->writeHead - hlsStream->readHead + SEEK_BUFFER_SIZE;
    size_t availableSize = hlsStream->capacity - currentSize;
    int64_t startOffset = max(0, (int64_t)hlsStream->readHead - SEEK_BUFFER_SIZE);
    size_t moveSize = hlsStream->writeHead - (size_t)startOffset;

    if (dataSize > availableSize) {
        // Grow the buffer
        size_t newCapacity = hlsStream->capacity;
        while (dataSize > (newCapacity - currentSize)) {
            newCapacity *= GROWTH_FACTOR;
        }
        // Allocate new buffer, copy existing data, free old buffer
    } else if (startOffset > 0) {
        // Compact: move data toward the beginning
        memmove(hlsStream->buffer, hlsStream->buffer + startOffset, moveSize);
    }

    // Append new data
    memcpy(hlsStream->buffer + hlsStream->writeHead, data, dataSize);
    hlsStream->writeHead += dataSize;
}
```

---

## Part VII: The Visual Experience — SDF Ray Marching and Retro TVs

With the functional pipeline complete, the visual presentation transforms decoded video into an immersive experience. Instead of simply displaying video in a flat rectangle, the HLS player scene renders decoded frames onto four retro television sets modeled entirely using Signed Distance Functions (SDFs) in a ray-marched 3D scene.

![Retro TV Scene Layout](../../assets/blog/03-vulkan-video/retro_tv_scene.svg)

### Ray Marching Fundamentals

The entire scene is rendered using ray marching — a technique where rays are cast from the camera through each pixel, and the scene geometry is evaluated by repeatedly stepping along each ray until a surface is found.

The fragment shader implements a standard sphere-tracing algorithm:

```hlsl
float2 rayMarch(float3 ro, float3 rd) {
    float t = 0.0;
    float materialId = 0.0;

    for (int i = 0; i < 64; i++) {
        float3 p = ro + rd * t;
        float3 result = mapScene(p);
        float d = result.x;
        materialId = result.y;

        if (d < 0.01) break;
        if (t > 100.0) {
            materialId = 0.0;
            break;
        }

        t += d;
    }

    return float2(t, materialId);
}
```

The `mapScene` function evaluates the distance from any point in space to the nearest surface, along with the material ID of that surface. By stepping along the ray in increments equal to this distance (which is guaranteed to be safe — no surface can be closer), the algorithm converges on the surface intersection point.

### SDF-Modeled Retro TVs

Each retro TV is a carefully crafted composition of SDF primitives:

**Main Body**: A rounded box (`sdRoundBox`) with dimensions 0.75 x 0.55 x 0.35 and a rounding radius of 0.08.

**Screen**: A flat box (`sdBox`) recessed into the front face, with dimensions 0.55 x 0.40 x 0.02.

**Bezel/Housing**: Another rounded box slightly larger than the screen, with a boolean subtraction to create the screen opening.

**Speaker Grille**: A small rounded box on the left side of the body.

**Control Panel**: A thin rounded box on the right side with three spherical knobs at different vertical positions.

**Legs**: Four capped cylinders supporting the body, spread at the corners.

**Antennas**: Two capsule shapes (rounded cylinders) extending from a cylindrical base on top, angled outward — the classic "rabbit ears."

```hlsl
float3 sdRetroTV(float3 p, int tvIndex) {
    p = p / 10.0; // scale down for comfortable SDF evaluation

    // Main body
    float3 pBody = p - float3(0.0, 0.1, -0.15);
    float dBody = sdRoundBox(pBody, float3(0.75, 0.55, 0.35), 0.08);

    // Screen glass
    float3 pScreen = p - float3(0.0, 0.1, 0.28);
    float dScreen = sdBox(pScreen, float3(0.55, 0.40, 0.02));

    // Bezel frame
    float3 pBezel = p - float3(0.0, 0.1, 0.20);
    float dBezel = sdRoundBox(pBezel, float3(0.62, 0.47, 0.04), 0.02);
    dBezel = max(dBezel, -sdBox(p - float3(0.0, 0.1, 0.30), float3(0.54, 0.39, 0.15)));

    // Knobs
    float3 pKnob1 = p - float3(0.72, 0.3, 0.22);
    float dKnob1 = sdSphere(pKnob1, 0.04);
    // ... more knobs ...

    // Antennas (rabbit ears)
    float dAnt1 = sdCapsule(p, float3(0.0, 0.68, -0.1), float3(-0.25, 1.1, -0.08), 0.012);
    float dAnt2 = sdCapsule(p, float3(0.0, 0.68, -0.1), float3(0.25, 1.1, -0.08), 0.012);

    // Material assignment through closest-surface tracking
    float d = dBody;
    float mat = 3.0; // wood material

    if (dScreen < d) { d = dScreen; mat = 10.0 + (float)tvIndex; } // screen
    if (dBezel < d) { d = dBezel; mat = 5.0; } // dark plastic
    // ... more material assignments ...

    return float3(d * 10.0, mat, (float)tvIndex);
}
```

The material ID encoding is clever: screen surfaces get material IDs 10-13 (10 + tvIndex), allowing the shader to identify which TV's screen was hit and sample the correct video texture.

### Scene Layout

Four TVs are placed in a semicircular arrangement, each at a different position and rotation:

```hlsl
static const float3 screenPositions[4] = {
    float3(-40.0, 12.0,  15.0),
    float3(-20.0, 12.0, -8.0),
    float3( 20.0, 12.0, -5.0),
    float3( 40.0, 12.0,  18.0)
};

static const float screenRotations[4] = { 0.45, 0.3, -0.3, -0.45 };
```

The ground plane is an infinite floor at y=0, rendered with a subtle grid pattern for depth perception.

### Normal Calculation

Surface normals are calculated using the standard central-difference method:

```hlsl
float3 calcNormal(float3 p) {
    const float eps = 0.001;
    return normalize(float3(
        mapScene(p + float3(eps, 0.0, 0.0)).x - mapScene(p - float3(eps, 0.0, 0.0)).x,
        mapScene(p + float3(0.0, eps, 0.0)).x - mapScene(p - float3(0.0, eps, 0.0)).x,
        mapScene(p + float3(0.0, 0.0, eps)).x - mapScene(p - float3(0.0, 0.0, eps)).x
    ));
}
```

This numerical gradient evaluation requires six evaluations of `mapScene`, which is why the scene's geometry is kept relatively simple — complex SDF scenes can become prohibitively expensive for real-time rendering.

### Soft Shadows

The scene implements Inigo Quilez's soft shadow algorithm, which produces physically plausible penumbra effects:

```hlsl
float calcSoftShadow(float3 ro, float3 rd, float mint, float tmax, float k)
{
    float res = 1.0;
    float t = mint;
    float ph = 1e10;

    for (int i = 0; i < 64; i++) {
        float h = mapScene(ro + rd * t).x;
        if (h < 0.001) return 0.0;

        float y = h * h / (2.0 * ph);
        float d = sqrt(h * h - y * y);
        res = min(res, k * d / max(0.0, t - y));
        ph = h;

        t += h;
        if (t > tmax) break;
    }
    return clamp(res, 0.0, 1.0);
}
```

The parameter `k` controls the shadow softness — lower values produce harder shadows, higher values produce softer penumbra. The algorithm tracks the closest approach of the shadow ray to any surface along its path, using this to estimate the angular extent of the shadow-casting geometry, producing realistic soft shadow edges.

### Lighting Model

The shade function implements a multi-light setup with physically motivated components:

1. **Sun Light**: A distant directional light providing the primary illumination.
2. **Sky Light**: A hemispherical ambient light from above, providing soft fill.
3. **Bounce Light**: An ambient contribution from below, simulating indirect light bouncing off the floor.
4. **Fill Light**: An additional directional light from a different angle to reduce harsh shadows.
5. **Rim Light**: A view-dependent highlight at object edges, adding visual separation.

Each material is defined by a base color, specular intensity, and specular power:

- Material 1 (floor): Dark metallic with a grid pattern overlay.
- Material 3 (TV body): Warm brown wood with procedural grain.
- Material 4 (legs): Darker brown wood.
- Material 5 (bezel, controls): Very dark plastic.
- Material 6 (speaker): Near-black fabric.
- Material 7 (walls/background): Gradient dark blue.
- Material 8 (antenna base): Dark brown.
- Material 9 (knobs, antenna tips): Bright brass with high specularity.
- Materials 10-13 (screens): Emissive materials showing video content.

---

## Part VIII: Color Science — YCbCr, BT.601, and the Shader Pipeline

One of the more specialized aspects of this project is the handling of video color spaces. H.264 video is encoded in YCbCr (also commonly written as YUV) color space, not RGB. Understanding and correctly implementing the conversion is essential for accurate color reproduction.

![Shader Rendering Pipeline](../../assets/blog/03-vulkan-video/shader_pipeline.svg)

### Why YCbCr?

The YCbCr color model separates luminance (brightness, Y) from chrominance (color, Cb and Cr). This separation has two major advantages for video compression:

1. **Perceptual efficiency**: The human visual system is much more sensitive to luminance than to chrominance. By separating these components, chrominance can be subsampled (stored at lower resolution) with minimal perceived quality loss.

2. **Decorrelation**: RGB channels in natural images are highly correlated. YCbCr decorrelates these signals, allowing each component to be compressed more efficiently.

### Chroma Subsampling: 4:2:0

In 4:2:0 subsampling, the chroma channels (Cb and Cr) have half the horizontal and half the vertical resolution of the luma (Y) channel. This means that for a 1920x1080 video:
- Y plane: 1920 x 1080 pixels
- CbCr plane: 960 x 540 pixels (interleaved)

This is the format stored in the Vulkan image (`VK_FORMAT_G8_B8R8_2PLANE_420_UNORM`):
- Plane 0: Y (luma) samples, one byte per pixel
- Plane 1: CbCr (chroma) samples, two bytes per pixel pair

### The Conversion Matrix

The conversion from YCbCr to RGB depends on the color space standard used. Different standards define different conversion matrices. The most common ones for video are:

**BT.601** (SD video, used by most HLS streams):
$$R = Y + 1.402 \cdot (Cr - 0.5)$$
$$G = Y - 0.344136 \cdot (Cb - 0.5) - 0.714136 \cdot (Cr - 0.5)$$
$$B = Y + 1.772 \cdot (Cb - 0.5)$$

**BT.709** (HD video):
$$R = Y + 1.5748 \cdot (Cr - 0.5)$$
$$G = Y - 0.1873 \cdot (Cb - 0.5) - 0.4681 \cdot (Cr - 0.5)$$
$$B = Y + 1.8556 \cdot (Cb - 0.5)$$

**BT.2020** (UHD/HDR video):
$$R = Y + 1.4746 \cdot (Cr - 0.5)$$
$$G = Y - 0.1646 \cdot (Cb - 0.5) - 0.5714 \cdot (Cr - 0.5)$$
$$B = Y + 1.8814 \cdot (Cb - 0.5)$$

The `ColorConverters.hlsl` shared shader library implements all three, plus full-range variants:

```hlsl
float3 yCbCrToRgbBt601(float3 ycbcr)
{
    float y = ycbcr.x;
    float cb = ycbcr.y - 0.5;
    float cr = ycbcr.z - 0.5;

    float r = y + 1.402 * cr;
    float g = y - 0.344136 * cb - 0.714136 * cr;
    float b = y + 1.772 * cb;

    return float3(r, g, b);
}
```

### Sampling in the Shader

The fragment shader samples the luma and chroma planes separately using the texture index system encoded in the push constants:

```hlsl
int texIndex = (data.textureIndices >> (tvIndex * 8)) & 0xFF;

if (texIndex < 5) {
    float y = SAMPLE_TEXTURE_TAB(textures, screenUV, texIndex * 2 + 0).r;
    float2 cbcr = SAMPLE_TEXTURE_TAB(textures, screenUV, texIndex * 2 + 1).rg;
    screenColor = yCbCrToRgbBt601(float3(y, cbcr));
    screenColor = pow(screenColor, float3(2.2)); // sRGB gamma correction
}
```

The `textureIndices` push constant encodes four 8-bit indices packed into a 32-bit integer:

```c
int32_t textureIndices = 0;
for (size_t i = 0; i < 4; i++) {
    int32_t texIdx = 5; // default: no texture
    if (i < sourceCount && sources[i].firstBound) {
        texIdx = (int32_t)i;
    }
    textureIndices |= (texIdx & 0xFF) << (i * 8);
}
```

When no video is available (texture index >= 5), the shader displays animated static noise:

```hlsl
float noise = frac(sin(dot(screenUV * 100.0, float2(12.9898, 78.233))) * 43758.5453);
screenColor = float3(noise * 0.05);
```

### Screen Effects

The shader applies several effects to make the video look like it is being displayed on a real CRT screen:

**Vignette**: Darkens the edges of the screen to simulate CRT light falloff:

```hlsl
float2 centered = screenUV * 2.0 - 1.0;
float vignette = 1.0 - dot(centered, centered) * 0.15;
screenColor *= vignette;
```

**Fresnel Reflection**: Adds a subtle reflected highlight at grazing angles, simulating the glass screen:

```hlsl
float fresnel = pow(saturate(1.0 - dot(normal, -rd)), 4.0);
screenColor += float3(0.15) * fresnel;
```

**Glow**: The screen material emits light slightly beyond the displayed content:

```hlsl
float3 emission = screenColor * 1.2;
float glow = 0.15;
emission += screenColor * glow;
```

### Post-Processing

The final image undergoes several post-processing steps:

1. **ACES Film Tonemapping**: Maps HDR values to the displayable [0,1] range using the ACES (Academy Color Encoding System) approximation:

```hlsl
float3 acesFilm(float3 x) {
    float a = 2.51;
    float b = 0.03;
    float c = 2.43;
    float d = 0.59;
    float e = 0.14;
    return saturate((x * (a * x + b)) / (x * (c * x + d) + e));
}
```

2. **Color Grading**: Subtle color adjustments for a cinematic look — warm lift in the shadows, slight blue shift in the whites.

3. **Contrast Enhancement**: Double smoothstep for gentle S-curve contrast.

4. **Saturation Boost**: Slight increase in color saturation (1.15x).

5. **Atmospheric Fog**: Distance-based fog blending toward a dark blue color, adding depth to the scene:

```hlsl
float fogIdx = 1.0 - exp(-saturate(dist / 100.0) * 2.0);
float3 fogCol = float3(0.01, 0.01, 0.06);
color = lerp(color, fogCol, fogIdx);
```

---

## Part IX: Audio-Video Synchronization

One of the hardest problems in any media player is keeping audio and video in sync. Even small discrepancies — more than 40-80 milliseconds — are perceptible to humans and create a jarring viewing experience.

### The Synchronization Strategy

The HLS player uses a time-based synchronization strategy. Both audio and video are indexed by absolute timestamps relative to the application's clock:

- **Video**: Each decoded frame has a `timestampSeconds` field computed from the segment's start time plus the frame's display order multiplied by the frame duration:
  ```c
  frame->timestampSeconds = chunk->timestampSeconds + frame->chunkDisplayOrder * video->frameDurationSeconds;
  ```

- **Audio**: The streaming audio player operates on a segment-by-segment basis. When a new segment is started, the audio for that segment is queued, and the player's buffer naturally advances at the audio sample rate.

### Segment Switching

When the current segment's duration has elapsed (measured by wall-clock time since the segment started playing), the context switches to the next segment:

```c
if (time - context->currentSegmentStartTime > context->currentSegment.duration) {
    __avdSceneHLSPlayerContextSwitchToNextSegment(vulkan, audio, context);
    context->currentSegmentPlayTime = 0.0f;
    context->currentSegmentStartTime = time;
    context->videoPlayer.timestampSecondsOffset = time;
}
```

During the switch:
1. The next segment is acquired from the segment store.
2. The audio player's buffer is cleared and refilled with the new segment's audio.
3. The video data is appended to the running HLS stream.
4. The video decoder's timestamp offset is updated.

### Framerate Detection

The video framerate is determined in two ways:

1. **From VUI timing info in the SPS**: If the SPS contains valid VUI parameters with timing info, the framerate is calculated directly:
   ```c
   float fps = (float)sps->vui.timeScale / (float)(2 * sps->vui.numUnitsInTick);
   ```

2. **Estimated from segment duration**: If VUI timing info is not available, the framerate is estimated by counting the number of frames in the segment and dividing by its duration:
   ```c
   context->currentSegmentTargetFramerate =
       avdH264VideoCountFrames(segment.h264Buffer, segment.h264Size) / segment.duration;
   ```

This is a practical compromise. Many real-world HLS streams, especially those from different encoders, may not include VUI timing information. The estimated framerate is usually accurate enough for smooth playback.

### Handling Buffer Starvation

If the player context runs out of data to decode — which can happen if the network is slow or the worker threads are busy — it triggers an early source refresh:

```c
if (!avdSceneHLSPlayerContextIsFed(&source->player) && time - source->lastRefreshed >= 1.0f) {
    AVD_LOG_WARN("HLS Player context ran out of data to decode/play!");
    __avdSceneHLSPlayerRequestSourceUpdate(appState, scene, (uint32_t)i);
}
```

This proactive approach helps recover from transient network issues by fetching updated playlist information sooner than the regular refresh interval.

---

## Part X: The Multithreaded Pipeline

The HLS player's data pipeline is inherently asynchronous. Downloading media over the network takes time, demuxing and parsing add latency, and all of this needs to happen without blocking the main rendering thread. AVD solves this with a carefully designed multithreaded worker pool.

![Worker Pool Pipeline Architecture](../../assets/blog/03-vulkan-video/worker_pipeline.svg)

### Thread Architecture

The worker pool creates three types of worker threads, connected by thread-safe channels:

```
[Main Thread] --source URL--> [Source Download Workers]
                                      |
                              parsed playlist,
                              media segment URLs
                                      |
                                      v
                              [Media Download Workers]
                                      |
                              raw .ts file data
                                      |
                                      v
                              [Media Demux Workers]
                                      |
                              separated H.264 + AAC data
                                      |
                                      v
[Main Thread] <--ready segment-- [Media Ready Channel]
```

### Source Download Workers

These threads receive source URLs (HLS playlist URLs), download them using curl, parse them with picoM3U8, and generate media download tasks for each segment in the playlist:

```c
static void __avdHLSSourceDownloadWorker(void *arg)
{
    AVD_HLSWorkerPool *pool = (AVD_HLSWorkerPool *)arg;

    while (pool->sourceDownloadRunning) {
        if (!picoThreadChannelReceive(pool->sourceDownloadChannel, &sourcePayload, 200)) {
            continue; // timeout, check if still running
        }

        // Download playlist text
        avdCurlFetchStringContent(sourceUrl, &data, NULL);

        // Parse playlist
        picoM3U8PlaylistParse(data, strlen(data), &playlist);

        // Enqueue each media segment for download
        for (uint32_t i = 0; i < playlist->media.mediaSegmentCount; i++) {
            // Resolve relative URL
            // Skip already-played segments
            // Send to media download channel
        }
    }
}
```

An important optimization is the check against `currentlyPlayingSegmentId` — segments that have already been played are skipped to avoid wasting bandwidth.

### Media Download Workers

These threads download individual media segments (.ts files). They implement a caching layer to avoid redundant downloads:

```c
static void __avdHLSMediaDownloadWorker(void *arg)
{
    while (pool->mediaDownloadRunning) {
        if (!picoThreadChannelReceive(pool->mediaDownloadChannel, &mediaPayload, 200)) {
            continue;
        }

        // Check cache first
        if (avdHLSMediaCacheQuery(pool->mediaCache, mediaPayload.urlHash, &data, &dataSize)) {
            // Cache hit — forward directly to demux
            picoThreadChannelSend(pool->mediaDemuxChannel, &demuxPayload);
            continue;
        }

        // Cache miss — download
        avdCurlDownloadToMemory(segmentUrl, &data, &dataSize);

        // Store in cache
        avdHLSMediaCacheInsert(pool->mediaCache, mediaPayload.urlHash, data, dataSize);

        // Forward to demux
        picoThreadChannelSend(pool->mediaDemuxChannel, &demuxPayload);
    }
}
```

### Media Cache

The media cache uses a fixed-size LRU (Least Recently Used) eviction strategy:

```c
#define AVD_HLS_MEDIA_CACHE_SIZE 32

typedef struct {
    picoThreadMutex mutex;
    AVD_HLSMediaCacheEntry entries[AVD_HLS_MEDIA_CACHE_SIZE];
} AVD_HLSMediaCache;
```

Each entry has a capacity field that allows buffer reuse — if a new entry fits in an evicted entry's buffer, the buffer is reused instead of being reallocated. This reduces memory allocation pressure during sustained playback.

### Media Demux Workers

These threads receive raw .ts file data, demux it using picoMpegTS, and produce separated H.264 video and AAC audio buffers:

```c
static void __avdHLSMediaDemuxWorker(void *arg)
{
    while (pool->mediaDemuxRunning) {
        if (!picoThreadChannelReceive(pool->mediaDemuxChannel, &demuxPayload, 200)) {
            continue;
        }

        picoMpegTS mpegts = picoMpegTSCreate(false);
        picoMpegTSAddBuffer(mpegts, data, dataSize);

        // Count total sizes for H.264 and AAC
        picoMpegTSPESPacket *pesPackets = picoMpegTSGetPESPackets(mpegts, &count);

        // Allocate buffers
        char *h264Buffer = malloc(totalH264Size);
        char *audioBuffer = malloc(totalAudioSize);

        // Concatenate PES payloads by stream type
        for (size_t i = 0; i < count; i++) {
            if (streamType == H264) {
                memcpy(h264Buffer + h264Offset, pesPacket->data, pesPacket->dataLength);
                h264Offset += pesPacket->dataLength;
            }
            if (streamType == AAC_ADTS) {
                memcpy(audioBuffer + audioOffset, pesPacket->data, pesPacket->dataLength);
                audioOffset += pesPacket->dataLength;
            }
        }

        // Send ready segment to main thread
        picoThreadChannelSend(pool->mediaReadyChannel, &readyPayload);
    }
}
```

### URL Pool

The URL pool is a thread-safe string interning system. URLs are hashed to 32-bit integers, and the pool maintains a mapping from hash to string:

```c
#define AVD_HLS_URL_POOL_CAPACITY 128
#define AVD_HLS_URL_MAX_LENGTH 2048

typedef struct {
    picoThreadMutex mutex;
    char urls[AVD_HLS_URL_POOL_CAPACITY][AVD_HLS_URL_MAX_LENGTH];
    uint32_t hashes[AVD_HLS_URL_POOL_CAPACITY];
    uint32_t accessCounters[AVD_HLS_URL_POOL_CAPACITY];
    uint32_t count;
    uint32_t accessCounter;
} AVD_HLSURLPool;
```

This avoids passing long URL strings through the thread channels. Instead, only 32-bit hashes are passed, and any thread can resolve a hash back to its URL by querying the pool. The pool uses LRU eviction when full.

### Channel-Based Communication

All inter-thread communication uses picoThreads' channel system — a typed, thread-safe FIFO queue with blocking receive and non-blocking try-receive operations.

The channels use unbounded queues, meaning producers never block. Consumers block with a timeout (200ms), which serves as both a receive wait and a periodic opportunity to check the `running` flag for graceful shutdown.

Item destructors are registered on channels that carry owning data:

```c
picoThreadChannelSetItemDestructor(pool->mediaDemuxChannel, __avdHLSWorkerPoolFreeDemuxPayload, NULL);
picoThreadChannelSetItemDestructor(pool->mediaReadyChannel, __avdHLSWorkerPoolFreeReadyPayload, NULL);
```

This ensures that if items are abandoned in the channel during shutdown, their memory is properly freed.

### Sources Hash: Handling Source Changes

A clever mechanism handles the case where the user changes the source URLs while segments from the old sources are still in the pipeline. Every task in the pipeline carries a `sourcesHash` field containing the hash of the source set at the time the task was created. When the main thread receives a ready segment, it compares the segment's hash to the current hash:

```c
if (payload.sourcesHash != scene->sourcesHash) {
    AVD_LOG_WARN("Received segment for outdated sources hash, discarding");
    avdHLSSegmentAVDataFree(&payload.avData);
    continue;
}
```

This prevents stale data from being decoded and displayed, ensuring a clean transition when sources change. When sources are changed (e.g., via drag-and-drop), the worker pool is flushed to clear any in-progress tasks:

```c
avdHLSWorkerPoolFlush(&hlsPlayer->workerPool);
avdHLSURLPoolClear(&hlsPlayer->urlPool);
__avdSceneHLSPlayerLoadSourcesFromPath(appState, hlsPlayer, newPath);
```

---

## Part XI: Lessons Learned and Retrospective

Building this system from scratch was an education in both media technology and systems engineering. Here are some of the key lessons:

### 1. Specifications Are Your Friend (and Your Enemy)

The ITU-T specifications for H.222.0 and H.264 are extraordinarily detailed and precise. Every field, every conditional, every edge case is documented. But the sheer volume of information makes them difficult to navigate, and there are frequent cross-references between different sections. The key to success was reading the specification alongside reference implementations (particularly FFmpeg's) and testing against real streams.

### 2. The Gap Between "Works" and "Works Correctly" Is Immense

Getting the first decoded frame to appear on screen was a milestone, but it was far from the end. Making the decoder work correctly for all frame types (I, P, B), all POC types (0, 1, 2), and all the edge cases in reference picture management took as much effort as the initial implementation. The git history tells the story: dozens of bug fix commits after the initial "basic video decoding" commit.

### 3. Vulkan Video Is Young and Under-Documented

The Vulkan Video extensions are relatively new, and documentation beyond the specification itself is sparse. Resources like the Khronos blog posts, Wicked Engine's implementation, and the "First Frames" blog post were invaluable. But many details — particularly around session parameter management, DPB lifecycle, and the coincide/distinct mode decision — had to be figured out through experimentation.

### 4. Thread Safety Is About Design, Not Just Mutexes

The worker pool's design — with clear ownership semantics, typed channels, and hash-based stale data detection — prevented entire categories of concurrency bugs. The most subtle bugs were not race conditions but logic errors in the pipeline's state management.

### 5. Audio-Video Sync Is a Continuous Challenge

The current synchronization approach — time-based with segment-boundary switching — works well for live streams where absolute timing precision is less critical than smooth continuous playback. A VOD player would need tighter synchronization, likely based on PTS values from the MPEG-TS layer.

### 6. Color Spaces Matter More Than You Think

Getting the YCbCr to RGB conversion wrong produces subtly incorrect colors that are hard to spot unless you are looking for them. The choice between BT.601 and BT.709 depends on the stream's resolution and encoding settings (encoded in the SPS VUI parameters), and using the wrong matrix produces a noticeable color shift.

### 7. The Value of Constraint-Driven Development

The self-imposed constraint of no external media libraries forced a deeper understanding of every layer of the media stack. Without this constraint, the project would have been much faster to build but much less educational. The libraries created for this project (picoM3U8, picoMpegTS, picoH264, picoAudio) are now reusable components available to anyone.

---

## Appendix: Resources and References

The development of this project was informed by numerous resources. Here is a comprehensive list:

### Specifications

- **HLS**: [RFC 8216 — HTTP Live Streaming](https://datatracker.ietf.org/doc/html/rfc8216)
- **MPEG-TS**: [ITU-T H.222.0 v9 (08/2023)](https://www.itu.int/rec/T-REC-H.222.0-202308-S/en)
- **H.264/AVC**: [ITU-T H.264 (V15) (08/2024)](https://handle.itu.int/11.1002/1000/15935)
- **DVB**: [ETSI EN 300 468](https://www.etsi.org/deliver/etsi_en/300400_300499/300468/01.16.01_60/en_300468v011601p.pdf)

### Vulkan Video

- [An Introduction to Vulkan Video (Khronos Blog)](https://www.khronos.org/blog/an-introduction-to-vulkan-video)
- [Vulkan Video Decoding — Wicked Engine](https://wickedengine.net/2023/05/vulkan-video-decoding/)
- [Video Decode: First Frames (Ponies and Light)](https://poniesandlight.co.uk/reflect/island_video_decoder/)
- [A Deep Dive into Vulkan Video — Vulkanised 2023](https://www.youtube.com/watch?v=R5x6_nBRrv4)
- [FFMPEG's Vulkan Video Implementation](https://lynne.ee/vulkan-video-decoding.html)
- [Khronos Vulkan Video Samples](https://github.com/KhronosGroup/Vulkan-Video-Samples)

### H.264 Video Compression

- [Video Compression Basics (Raster Grid)](https://www.rastergrid.com/blog/multimedia/2021/05/video-compression-basics/)
- [H.264/AVC Picture Management (VCodex)](https://www.vcodex.com/h264avc-picture-management/)
- [H.264 Video Data Prep — Wicked Engine](https://github.com/turanszkij/WickedEngine/blob/master/WickedEngine/wiVideo.cpp)
- [Wicked Engine Vulkan Video Implementation](https://github.com/turanszkij/WickedEngine/blob/master/WickedEngine/wiGraphicsDevice_Vulkan.cpp)

### MPEG Transport Stream

- [MPEG Transport And Multicasting (YouTube)](https://www.youtube.com/watch?v=CW_C9_PGpCM)
- [FFmpeg MPEG-TS Implementation](https://github.com/FFmpeg/FFmpeg/blob/master/libavformat/mpegts.c)
- [TSDuck MPEG-TS Introduction](https://tsduck.io/docs/mpegts-introduction.pdf)

### Tools

- [Media Analyzer Pro](https://media-analyzer.pro/app) — Online tool for analyzing media files and streams.

### Libraries Used

- [libpico](https://github.com/Jaysmito101/libpico) — The collection of single-header C libraries created for this project.
- [PortAudio](https://github.com/PortAudio/portaudio) — Cross-platform audio I/O.
- [GLFW](https://github.com/glfw/glfw) — Windowing and input.
- [Volk](https://github.com/zeux/volk) — Vulkan function loader.

### SDF and Ray Marching

- [Inigo Quilez — Distance Functions](https://iquilezles.org/articles/distfunctions/)
- [Inigo Quilez — Soft Shadows](https://iquilezles.org/articles/rmshadows/)
- [ACES Filmic Tonemapping](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/)

---

## Detailed Technical Appendices

### Appendix A: The Full Data Flow

Let us trace a single video frame from its origin as a live camera feed all the way to a pixel on the screen:

1. **Capture**: A camera captures a frame of video somewhere in the world.

2. **Encoding**: An encoder (x264, nvenc, etc.) compresses this frame into H.264. If it is an I-frame, it contains all the data needed to reconstruct the image. If it is a P or B frame, it contains only the differences from reference frames. The encoder also produces SPS and PPS data that describes the stream's properties.

3. **Muxing**: The compressed video frame (as a NAL unit) is wrapped in a PES packet with timing information (PTS/DTS) and then split into 188-byte MPEG-TS transport packets. Audio from the microphone or mixer is similarly encoded (as AAC) and multiplexed into the same transport stream.

4. **Segmenting**: The continuous transport stream is divided into segments, typically 2-10 seconds long. Each segment is a complete .ts file.

5. **Playlist Generation**: An M3U8 playlist file is generated or updated with the URLs of the latest segments. For live streams, this file is continuously updated by the server, with old segments being removed and new ones added.

6. **Network Delivery**: The playlist and segment files are served over HTTP by a web server or CDN.

7. **Playlist Fetch** (AVD — Source Download Worker): The worker thread downloads the M3U8 playlist text.

8. **Playlist Parsing** (AVD — Source Download Worker): picoM3U8 parses the playlist text, extracting segment URIs, durations, and sequence numbers.

9. **Segment Download** (AVD — Media Download Worker): Each segment URL is downloaded to memory. The media cache is checked first to avoid redundant downloads.

10. **MPEG-TS Demuxing** (AVD — Media Demux Worker): picoMpegTS parses the .ts file, extracting PES packets. The PAT and PMT are parsed to identify video and audio stream PIDs. PES payloads are concatenated by stream type to produce separate H.264 and AAC buffers.

11. **H.264 Parsing** (AVD — Main Thread): The H.264 buffer is appended to the HLS stream and parsed by picoH264 through the avdH264VideoLoadChunk function. NAL units are identified, SPS and PPS are parsed and stored, and slice headers are analyzed to compute frame information including picture order count and display order.

12. **Vulkan Video Session Setup** (AVD — Main Thread): If the SPS or PPS has changed, session parameters are recreated from the parsed data. The DPB and decoded frame images are created or resized as needed.

13. **GPU Decode** (AVD — Main Thread, GPU): A Vulkan command buffer is recorded with the video decode command, specifying the bitstream buffer, reference pictures, and output DPB slot. The command is submitted to the video decode queue and the GPU decodes the frame.

14. **Frame Copy** (AVD — Main Thread, GPU): The decoded frame is copied from the DPB to a dedicated output image, transitioning through the appropriate image layouts. The luma and chroma planes are copied separately.

15. **Descriptor Update** (AVD — Main Thread): The output image's luma and chroma views are written into the bindless descriptor set.

16. **Rendering** (AVD — Main Thread, GPU): The fragment shader ray-marches through the SDF scene. When a screen surface is hit, the shader uses the texture index to sample the luma and chroma textures, converts YCbCr to RGB using the BT.601 matrix, applies gamma correction, vignette, fresnel, and glow effects, and blends the result with the scene lighting.

17. **Post-Processing** (AVD — Fragment Shader): ACES tonemapping, color grading, contrast enhancement, saturation boost, and atmospheric fog are applied.

18. **Display**: The final framebuffer is presented to the screen via the Vulkan swapchain.

The entire chain executes continuously, with multiple segments at different stages of the pipeline simultaneously, ensuring smooth, uninterrupted playback.

### Appendix B: Understanding the Push Constants

The push constants structure bridges the CPU and GPU, carrying per-frame data to the shaders:

```c
typedef struct {
    uint32_t activeSources;   // Bitmask of active sources (currently unused)
    int32_t indexCount;       // Vertex count (for shader reference)
    int32_t textureIndices;   // Packed 4x 8-bit texture indices
    int32_t pad1;             // Padding for alignment
    AVD_Vector4 cameraPosition;  // Camera world position
    AVD_Vector4 cameraDirection; // Camera look direction
} AVD_HLSPlayerPushConstants;
```

The `textureIndices` field uses a compact encoding where each byte represents the texture index for one TV source. A value of 5 or greater indicates "no texture bound" — the shader should display static noise. This encoding was chosen for simplicity and efficiency, avoiding the need for separate per-TV uniform data.

### Appendix C: The Vertex Shader

The vertex shader is remarkably simple — it just generates a full-screen triangle pair:

```hlsl
VertexShaderOutput main(uint vertexIndex : SV_VertexID) : SV_Position {
    float3 position = positions[vertexIndex % 6];
    VertexShaderOutput output;
    output.position = float4(position, 1.0);
    output.uv = float2(position.x, position.y) * 0.5 + 0.5;
    return output;
}
```

The six vertices define two triangles covering the entire screen. The UV coordinates map from [-1,1] clip space to [0,1] texture space. The fragment shader then performs all the ray marching work — no traditional geometry is used.

### Appendix D: SDF Utility Functions

The shared SDFUtils library provides a comprehensive set of SDF primitives:

- `sdSphere`: Distance to a sphere.
- `sdBox`: Distance to an axis-aligned box.
- `sdRoundBox`: Distance to a rounded box (box with rounded edges).
- `sdBoxFrame`: Distance to a box frame (wireframe box).
- `sdTorus`: Distance to a torus.
- `sdCappedCylinder`: Distance to a capped cylinder.
- `sdCapsule`: Distance to a capsule (cylinder with hemispherical caps).
- And many more.

These primitives are combined using min (union), max (intersection), and subtraction operations to create complex shapes. The retro TV model demonstrates this compositional approach, assembling a recognizable object from approximately a dozen primitive operations.

### Appendix E: The Camera System

The camera implements a first-person fly camera with mouse-look and WASD movement:

**Mouse Look**: Left-click drag rotates the camera. Horizontal movement adjusts yaw, vertical movement adjusts pitch (clamped to approximately ±81 degrees to prevent gimbal lock):

```c
hlsPlayer->cameraYaw += deltaX * sensitivity;
hlsPlayer->cameraPitch -= deltaY * sensitivity;
hlsPlayer->cameraPitch = clamp(hlsPlayer->cameraPitch, -PI * 0.45f, PI * 0.45f);

hlsPlayer->cameraDirection.x = cosf(cameraPitch) * sinf(cameraYaw);
hlsPlayer->cameraDirection.y = sinf(cameraPitch);
hlsPlayer->cameraDirection.z = cosf(cameraPitch) * cosf(cameraYaw);
```

**Movement**: W/S move forward/backward along the camera's horizontal direction (Y component zeroed to prevent flying upward when looking up). A/D strafe left/right. Q/E move up/down. All movement is scaled by frame delta time for frame-rate-independent speed.

**Scroll Zoom**: Mouse scroll moves the camera along its forward direction.

### Appendix F: The Integrity Check

Before the scene loads, an integrity check validates that all required capabilities are available:

```c
static bool avdSceneHLSPlayerCheckIntegrity(struct AVD_AppState *appState, const char **statusMessage)
{
    if (!appState->vulkan.supportedFeatures.videoDecode) {
        *statusMessage = "HLS Player scene is not supported on this GPU (video decode not supported).";
        return false;
    }

    if (!avdCurlIsSupported()) {
        *statusMessage = "HLS Player scene requires curl cli to be installed and available in PATH.";
        return false;
    }

    return true;
}
```

This ensures a clean error message is displayed on GPUs without Vulkan Video support or on systems where curl is not available.

### Appendix G: Debug Segment Saving

For development and debugging, the scene can save decoded segments to disk:

```c
#ifdef AVD_SCENE_HLS_PLAYER_SAVE_SEGMENTS_TO_DISK
static bool __avdSceneHLSPlayerSaveSegmentToDisk(AVD_HLSSegmentAVData *avData)
{
    snprintf(buffer, sizeof(buffer), "hls_segments/source_%zu/h264/%zu.h264", avData->source, avData->segmentId);
    avdWriteBinaryFile(buffer, avData->h264Buffer, avData->h264Size);

    snprintf(buffer, sizeof(buffer), "hls_segments/source_%zu/aac_adts/%zu.aac", avData->source, avData->segmentId);
    avdWriteBinaryFile(buffer, avData->aacBuffer, avData->aacSize);
}
#endif
```

This was invaluable during development for analyzing extracted streams with external tools (e.g., `ffprobe`, `mediainfo`, or the Media Analyzer Pro web tool) to verify that the demuxer was producing correct output.

---

## Conclusion: From Curiosity to Capability

What started as a curiosity about how TV works became one of the most technically ambitious parts of the Advanced Vulkan Demos project. The journey from "I want to play video" to "I have retro TVs showing live streams in a ray-marched 3D scene" touched on network protocols, container formats, video compression standards, hardware acceleration APIs, color science, audio engineering, multithreaded systems design, and procedural 3D modeling — all without a single line of code from any existing media framework.

The four pico libraries created for this project — picoM3U8, picoMpegTS, picoH264, and picoAudio — now exist as standalone, reusable components. The Vulkan Video infrastructure built for AVD provides a solid foundation for any future video decode work. And the HLS player scene itself serves as both a portfolio piece and a reference implementation for anyone interested in building custom media players with Vulkan.

Is it a production-quality media player? No. It handles only H.264 (not H.265 or AV1), only 4:2:0 chroma (not 4:2:2 or 4:4:4), only media playlists (not master playlists with adaptive bitrate), and its synchronization strategy is designed for live streams rather than video-on-demand. But it works, reliably, with real internet live streams, in real-time, rendered on retro TV sets in a fully ray-marched 3D scene.

And sometimes, building something that works is reason enough to build it.

---

## Demo

Here's the HLS player in action, rendering live video on retro television sets in a ray-marched Vulkan scene:

<iframe width="100%" height="600" src="https://www.youtube.com/embed/nnYdYYJBc6s" title="Live HLS Video Player in Vulkan" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

---

*All source code for this project is available on GitHub:*
- *[Advanced Vulkan Demos](https://github.com/Jaysmito101/AdvancedVulkanDemos)*
- *[libpico](https://github.com/Jaysmito101/libpico)*
