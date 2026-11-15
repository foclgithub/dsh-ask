//! UTF-16 ↔ grapheme 光标映射契约（协议文档 §4）。
//!
//! 父进程给的 `inputCursor` 是 **UTF-16 code unit 索引**（JS 字符串语义），
//! 显示层必须把它映射到 grapheme cluster 边界，才能在中文、emoji（😀 占 2 个
//! code unit）、组合字符（e + U+0301）、ZWJ emoji 序列上正确放置光标与插入点。
//!
//! 契约点：
//! * 越界索引必须 clamp，不得 panic；
//! * 合法 UTF-16 边界位置精确映射到对应的 grapheme 边界；
//! * 落在 grapheme 内部的索引只允许落到该 grapheme 的前或后边界（绝不劈开它）；
//! * 在每个 grapheme 边界上，两个方向互为逆映射。

use dsh_ask_ui::text;

/// 一个字符串的 UTF-16 code unit 数量（JS 的 `string.length`）。
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// ZWJ 家庭 emoji：4 个 emoji 用 U+200D 连接，整体是 1 个 grapheme、11 个 UTF-16 unit。
const FAMILY: &str = "\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}";

/// 覆盖 ASCII / 中文 / emoji / 组合字符 / ZWJ 序列 / 换行的样本。
const SAMPLES: &[&str] = &["", "abc", "中文😀a", "e\u{301}", FAMILY, "a中\n😀 b"];

#[test]
fn empty_text_has_no_graphemes_and_clamps_to_zero() {
    assert_eq!(text::grapheme_count(""), 0);
    assert_eq!(text::utf16_to_grapheme("", 0), 0);
    // 空串上的任意索引都必须 clamp 到 0，而不是 panic 或越界。
    assert_eq!(text::utf16_to_grapheme("", 99), 0, "空串越界索引必须 clamp 到 0");
    assert_eq!(text::grapheme_to_utf16("", 0), 0);
    assert_eq!(text::grapheme_to_utf16("", 99), 0, "空串越界 grapheme 索引必须 clamp 到 0");
}

#[test]
fn ascii_maps_one_to_one() {
    let text = "abc";
    assert_eq!(text::grapheme_count(text), 3);

    // 纯 ASCII：UTF-16 索引与 grapheme 索引一一对应。
    for index in 0..=3 {
        assert_eq!(text::utf16_to_grapheme(text, index), index);
        assert_eq!(text::grapheme_to_utf16(text, index), index);
    }
    assert_eq!(text::utf16_to_grapheme(text, 99), 3, "越界 UTF-16 索引必须 clamp 到末尾");
    assert_eq!(text::grapheme_to_utf16(text, 99), 3, "越界 grapheme 索引必须 clamp 到末尾");
}

#[test]
fn cjk_and_emoji_map_utf16_indices_to_grapheme_boundaries() {
    // "中文😀a"：grapheme 中/文/😀/a = 4 个；UTF-16 1+1+2+1 = 5 个 code unit。
    let text = "中文😀a";
    assert_eq!(text::grapheme_count(text), 4, "中/文/😀/a 共 4 个 grapheme");
    assert_eq!(utf16_len(text), 5, "😀 占 2 个 UTF-16 code unit");

    // 合法 UTF-16 边界位置：精确映射。
    assert_eq!(text::utf16_to_grapheme(text, 0), 0, "开头");
    assert_eq!(text::utf16_to_grapheme(text, 1), 1, "中文之后");
    assert_eq!(text::utf16_to_grapheme(text, 2), 2, "😀 之前");
    assert_eq!(text::utf16_to_grapheme(text, 4), 3, "😀（代理对）之后、a 之前");
    assert_eq!(text::utf16_to_grapheme(text, 5), 4, "末尾");

    // 代理对中间（index=3）不是合法字符边界：光标只能落到 😀 的前或后边界。
    let mid = text::utf16_to_grapheme(text, 3);
    assert!(
        mid == 2 || mid == 3,
        "代理对中间的 UTF-16 索引只能落到相邻 grapheme 边界，实际 {mid}"
    );

    // 反向：grapheme 边界 → UTF-16 偏移。
    assert_eq!(text::grapheme_to_utf16(text, 0), 0);
    assert_eq!(text::grapheme_to_utf16(text, 1), 1);
    assert_eq!(text::grapheme_to_utf16(text, 2), 2);
    assert_eq!(text::grapheme_to_utf16(text, 3), 4);
    assert_eq!(text::grapheme_to_utf16(text, 4), 5);
}

#[test]
fn combining_mark_cluster_is_one_grapheme() {
    // "e" + U+0301（组合尖音符）：2 个 code point / 2 个 UTF-16 unit，1 个 grapheme。
    let text = "e\u{301}";
    assert_eq!(text.chars().count(), 2);
    assert_eq!(utf16_len(text), 2);
    assert_eq!(text::grapheme_count(text), 1, "组合字符整体是一个 grapheme");

    assert_eq!(text::utf16_to_grapheme(text, 0), 0, "开头");
    let mid = text::utf16_to_grapheme(text, 1);
    assert!(
        mid == 0 || mid == 1,
        "组合字符内部索引只能落到 cluster 的前/后边界，实际 {mid}"
    );
    assert_eq!(text::utf16_to_grapheme(text, 2), 1, "末尾");

    assert_eq!(text::grapheme_to_utf16(text, 0), 0);
    assert_eq!(text::grapheme_to_utf16(text, 1), 2, "跳过整个组合字符 cluster");
}

#[test]
fn zwj_emoji_family_is_one_grapheme() {
    // 4 个 emoji + 3 个 ZWJ：11 个 UTF-16 unit，但只算 1 个 grapheme。
    assert_eq!(utf16_len(FAMILY), 11);
    assert_eq!(text::grapheme_count(FAMILY), 1, "ZWJ 家庭 emoji 是一个 grapheme");

    // 任意内部索引都只能 clamp 到 0 或 1（不得把家庭拆成多段）。
    for index in 0..=11 {
        let mapped = text::utf16_to_grapheme(FAMILY, index);
        assert!(
            mapped <= 1,
            "ZWJ 序列内部索引 {index} 必须 clamp 到 0/1，实际 {mapped}"
        );
    }
    assert_eq!(text::utf16_to_grapheme(FAMILY, 0), 0);
    assert_eq!(text::utf16_to_grapheme(FAMILY, 11), 1);
    assert_eq!(text::grapheme_to_utf16(FAMILY, 0), 0);
    assert_eq!(text::grapheme_to_utf16(FAMILY, 1), 11);
}

#[test]
fn round_trip_is_the_inverse_on_every_grapheme_boundary() {
    for sample in SAMPLES {
        let count = text::grapheme_count(sample);
        // 0 和 count 是首尾边界。
        assert_eq!(text::grapheme_to_utf16(sample, 0), 0, "样本 {sample:?} 开头偏移");
        assert_eq!(
            text::grapheme_to_utf16(sample, count),
            utf16_len(sample),
            "样本 {sample:?} 末尾偏移必须等于 UTF-16 长度"
        );

        for grapheme_index in 0..=count {
            let units = text::grapheme_to_utf16(sample, grapheme_index);
            assert_eq!(
                text::utf16_to_grapheme(sample, units),
                grapheme_index,
                "样本 {sample:?} 的 grapheme 边界 {grapheme_index}（UTF-16 {units}）必须双向互逆"
            );
        }
    }
}

#[test]
fn utf16_index_never_splits_a_grapheme_and_is_monotonic() {
    for sample in SAMPLES {
        let len = utf16_len(sample);
        let count = text::grapheme_count(sample);
        let mut previous = 0usize;

        for index in 0..=len {
            let mapped = text::utf16_to_grapheme(sample, index);
            // 结果始终是合法 grapheme 索引。
            assert!(
                mapped <= count,
                "样本 {sample:?} 的 UTF-16 索引 {index} 映射出越界 grapheme {mapped}（count={count}）"
            );
            // UTF-16 索引增大时光标只能前进或停住，必须单调。
            assert!(
                mapped >= previous,
                "样本 {sample:?} 的映射必须单调：索引 {index} 得到 {mapped} < 上一个 {previous}"
            );
            previous = mapped;

            // 若索引落在某个 grapheme 内部，只允许落到该 grapheme 的前/后边界。
            for cluster in 0..count {
                let start = text::grapheme_to_utf16(sample, cluster);
                let end = text::grapheme_to_utf16(sample, cluster + 1);
                if start < index && index < end {
                    assert!(
                        mapped == cluster || mapped == cluster + 1,
                        "样本 {sample:?} 的 UTF-16 索引 {index} 在 grapheme {cluster}（{start}..{end}）内部，\
                         光标只能落到前后边界，实际 {mapped}"
                    );
                }
            }
        }
    }
}

#[test]
fn out_of_range_indices_clamp_to_the_end() {
    for sample in SAMPLES {
        let count = text::grapheme_count(sample);
        let len = utf16_len(sample);
        assert_eq!(
            text::utf16_to_grapheme(sample, len + 100),
            count,
            "样本 {sample:?} 的越界 UTF-16 索引必须 clamp 到末尾 grapheme"
        );
        assert_eq!(
            text::grapheme_to_utf16(sample, count + 100),
            len,
            "样本 {sample:?} 的越界 grapheme 索引必须 clamp 到末尾 UTF-16 偏移"
        );
    }
}
