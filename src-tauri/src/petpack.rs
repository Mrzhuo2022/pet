//! petpack 皮肤包管理 + 全局设置持久化。
//!
//! 内置包由前端从 `/petskins/index.json` 读取；用户包（appData/petskins/<id>/）
//! 支持从 zip 或文件夹导入：
//! - zip/文件夹内已有 petpack.json → 原样使用；
//! - 只有 Live2D 模型（*.model3.json，或解包器输出、按内容识别的 model*.json）
//!   → 依据模型 JSON 的 Motions 分组
//!   自动生成默认 petpack.json（generated: true，用户可自行编辑精调）。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{self, Read};
use std::sync::Mutex;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PetpackInfo {
    pub id: String,
    pub name: String,
    pub engine: String,
    /// 皮肤包目录的绝对路径
    pub path: String,
    /// petpack.json 带 generated: true（导入时依据 model3.json 自动生成）
    pub generated: bool,
    /// 导入时间（目录创建时间，epoch ms；旧包/取不到时 None）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub imported_at: Option<u64>,
}

#[derive(Deserialize, Serialize, Default, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowState {
    pub x: Option<i32>,
    pub y: Option<i32>,
    /// 相对基准窗口(360x480 逻辑)的缩放
    pub scale: Option<f64>,
}

fn default_true() -> bool {
    true
}
fn default_volume() -> f64 {
    0.6
}
fn default_bubble_ms() -> u64 {
    2600
}
fn default_walk_freq() -> String {
    "normal".into()
}
fn default_walk_speed() -> f64 {
    55.0
}
fn default_ambient() -> bool {
    true
}
fn default_gravity() -> f64 {
    3000.0
}
fn default_bounce() -> f64 {
    0.45
}
fn default_fling_min() -> f64 {
    220.0
}
fn default_ambient_interval() -> u64 {
    40
}
fn default_fling() -> bool {
    true
}
fn default_ground() -> bool {
    true
}

/// 单只桌宠实例配置（窗口 label == id）
#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Pet {
    pub id: String,
    /// None = 使用皮肤列表的第一项
    pub petpack: Option<String>,
    /// 自定义显示名；None 时前端回退「皮肤名 · 序号」
    pub display_name: Option<String>,
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub scale: Option<f64>,
    pub lock_position: bool,
    pub roam_enabled: bool,
    pub sound_enabled: bool,
    pub bubble_enabled: bool,
    /// 待机闲聊：空闲时随机播一条动作+语音+气泡
    #[serde(default = "default_ambient")]
    pub ambient_enabled: bool,
    /// 拖拽抛掷：松手带惯性滑行、撞屏幕边缘反弹
    #[serde(default = "default_fling")]
    pub fling_enabled: bool,
    /// 视角跟随：眼神看向鼠标方向（静止后回正）
    #[serde(default = "default_true")]
    pub gaze_enabled: bool,
    /// 跟随鼠标：空闲时慢慢走到鼠标位置（移动中实时改路径）
    #[serde(default)]
    pub follow_enabled: bool,
    /// 任务栏模式：桌宠贴在当前显示器工作区底沿（任务栏上沿）活动，
    /// 拖拽松手/抛掷停下后落地，走动和跟随都沿地面
    #[serde(default = "default_ground")]
    pub ground_enabled: bool,
    pub always_on_top: bool,
    pub walk_freq: String,
    pub walk_speed: f64,
    /// 当前服装：0 = 模型默认，i = 皮肤包 manifest.outfits[i-1]（右键菜单换装）
    #[serde(default)]
    pub outfit_index: u32,
}

impl Default for Pet {
    fn default() -> Self {
        Self {
            id: String::new(),
            petpack: None,
            display_name: None,
            x: None,
            y: None,
            scale: Some(1.0),
            lock_position: false,
            roam_enabled: true,
            sound_enabled: true,
            bubble_enabled: true,
            ambient_enabled: default_ambient(),
            fling_enabled: default_fling(),
            gaze_enabled: true,
            follow_enabled: false,
            ground_enabled: default_ground(),
            always_on_top: true,
            walk_freq: default_walk_freq(),
            walk_speed: default_walk_speed(),
            outfit_index: 0,
        }
    }
}

impl Pet {
    pub(crate) fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            ..Default::default()
        }
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub pets: Vec<Pet>,
    #[serde(default = "default_volume")]
    pub volume: f64,
    #[serde(default = "default_bubble_ms")]
    pub bubble_ms: u64,
    /// 抛掷重力（物理 px/s²，任务栏模式落地手感）
    #[serde(default = "default_gravity")]
    pub gravity: f64,
    /// 反弹恢复系数 0–0.8：撞墙/落地弹跳强度
    #[serde(default = "default_bounce")]
    pub bounce_restitution: f64,
    /// 触发抛掷的最低松手速度（物理 px/s），低于则直接落下
    #[serde(default = "default_fling_min")]
    pub fling_min_speed: f64,
    /// 待机闲聊最短间隔（秒，实际在 min–min×2.75 间随机）
    #[serde(default = "default_ambient_interval")]
    pub ambient_interval_sec: u64,
    // ---- v1 旧字段：仅用于迁移，保存时不再写回 ----
    #[serde(skip_serializing)]
    pub active_petpack: Option<String>,
    #[serde(skip_serializing)]
    pub lock_position: bool,
    #[serde(default = "default_true")]
    pub always_on_top: bool,
    #[serde(skip_serializing, default = "default_true")]
    pub sound_enabled: bool,
    #[serde(skip_serializing, default = "default_true")]
    pub bubble_enabled: bool,
    #[serde(skip_serializing, default = "default_true")]
    pub roam_enabled: bool,
    #[serde(skip_serializing)]
    pub walk_freq: String,
    #[serde(skip_serializing)]
    pub walk_speed: f64,
    #[serde(skip_serializing)]
    pub window: WindowState,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            pets: Vec::new(),
            volume: default_volume(),
            bubble_ms: default_bubble_ms(),
            gravity: default_gravity(),
            bounce_restitution: default_bounce(),
            fling_min_speed: default_fling_min(),
            ambient_interval_sec: default_ambient_interval(),
            active_petpack: None,
            lock_position: false,
            always_on_top: true,
            sound_enabled: true,
            bubble_enabled: true,
            roam_enabled: true,
            walk_freq: default_walk_freq(),
            walk_speed: default_walk_speed(),
            window: WindowState::default(),
        }
    }
}

pub(crate) fn next_pet_id(s: &Settings) -> String {
    (1..)
        .map(|n| format!("pet-{n}"))
        .find(|id| !s.pets.iter().any(|p| &p.id == id))
        .unwrap_or_else(|| format!("pet-{}", s.pets.len() + 1))
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn packs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data(app)?.join("petskins");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data(app)?.join("settings.json"))
}

/// 进程内设置读写锁：多个桌宠窗口会并发保存位置，读改写必须串行，避免丢更新
static SETTINGS_LOCK: Mutex<()> = Mutex::new(());

fn lock_settings() -> std::sync::MutexGuard<'static, ()> {
    SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// 解析设置 JSON（纯函数，便于单测）；旧版单宠字段保留反序列化能力
pub(crate) fn parse_settings(text: &str) -> Result<Settings, String> {
    serde_json::from_str(text).map_err(|e| format!("设置文件解析失败: {e}"))
}

fn read_settings_file(path: &Path) -> Result<Settings, String> {
    let text = match fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Settings::default()),
        Err(e) => return Err(format!("读取设置失败: {e}")),
    };
    parse_settings(&text)
}

/// 原子写：先写临时文件再替换，避免读到半截 JSON
fn write_settings_file(path: &Path, s: &Settings) -> Result<(), String> {
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| e.to_string())?;
    if fs::rename(&tmp, path).is_err() {
        // 少数文件系统上 rename 覆盖会失败，退回直接写
        fs::write(path, &text).map_err(|e| e.to_string())?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

fn read_settings(app: &AppHandle) -> Result<Settings, String> {
    read_settings_file(&settings_path(app)?)
}

fn write_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    write_settings_file(&settings_path(app)?, s)
}

/// v1 单宠设置 → v2 pets[0]；已有 pets 时原样返回（纯函数，便于单测）
pub(crate) fn migrate_settings(mut s: Settings) -> Settings {
    if s.pets.is_empty() {
        let mut pet = Pet::new("pet-1");
        pet.petpack = s.active_petpack.clone();
        pet.x = s.window.x;
        pet.y = s.window.y;
        pet.scale = s.window.scale.or(Some(1.0));
        pet.lock_position = s.lock_position;
        pet.roam_enabled = s.roam_enabled;
        pet.sound_enabled = s.sound_enabled;
        pet.bubble_enabled = s.bubble_enabled;
        pet.always_on_top = s.always_on_top;
        pet.walk_freq = s.walk_freq.clone();
        pet.walk_speed = s.walk_speed;
        s.pets.push(pet);
    }
    s
}

pub(crate) fn load_settings(app: &AppHandle) -> Settings {
    let _guard = lock_settings();
    read_settings(app).unwrap_or_default()
}

pub(crate) fn save_settings(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let _guard = lock_settings();
    write_settings(app, s)
}

/// 读改写一体化：命令层统一用它，保证多桌宠并发保存不互相覆盖
pub(crate) fn with_settings<R>(
    app: &AppHandle,
    f: impl FnOnce(&mut Settings) -> Result<R, String>,
) -> Result<R, String> {
    let _guard = lock_settings();
    let mut s = read_settings(app)?;
    let out = f(&mut s)?;
    write_settings(app, &s)?;
    Ok(out)
}

/// 首次启动 / 从 v1 单宠设置升级：确保至少存在一只桌宠并写回新格式
pub(crate) fn init_settings(app: &AppHandle) -> Settings {
    let mut s = load_settings(app);
    if s.pets.is_empty() {
        // 文件存在但解析失败：先留一份 .bad 备份，避免直接覆盖用户数据
        if let Ok(path) = settings_path(app)
            && path.exists()
            && read_settings(app).is_err()
        {
            let _ = fs::rename(&path, path.with_extension("json.bad"));
        }
        s = migrate_settings(s);
        let _ = save_settings(app, &s);
    }
    s
}

/// 内置皮肤索引在编译期嵌入，供右键菜单列出皮肤（与前端 index.json 同源）
const BUILTIN_INDEX: &str = include_str!("../../public/petskins/index.json");

pub(crate) fn builtin_packs() -> Vec<(String, String)> {
    let v: serde_json::Value =
        serde_json::from_str(BUILTIN_INDEX).unwrap_or(serde_json::Value::Null);
    v.get("packs")
        .and_then(|p| p.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|p| {
                    let id = p.get("id")?.as_str()?.to_string();
                    let name = p
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    Some((id, name))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 目录导入时间：优先创建时间，取不到退回修改时间（epoch ms）
fn dir_imported_at(dir: &Path) -> Option<u64> {
    let meta = fs::metadata(dir).ok()?;
    let t = meta.created().ok().or_else(|| meta.modified().ok())?;
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

/// 读取并校验皮肤包目录里的 petpack.json
fn read_manifest(dir: &Path) -> Result<PetpackInfo, String> {
    let text = fs::read_to_string(dir.join("petpack.json"))
        .map_err(|e| format!("读取 petpack.json 失败: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("petpack.json 不是合法 JSON: {e}"))?;
    let id = v["id"].as_str().ok_or("petpack.json 缺少 id")?.to_string();
    let name = v["name"].as_str().unwrap_or(&id).to_string();
    let engine = v["engine"]
        .as_str()
        .ok_or("petpack.json 缺少 engine")?
        .to_string();
    if !matches!(engine.as_str(), "live2d" | "sprite") {
        return Err(format!("不支持的 engine: {engine}"));
    }
    Ok(PetpackInfo {
        id,
        name,
        engine,
        path: dir.to_string_lossy().to_string(),
        generated: v["generated"].as_bool().unwrap_or(false),
        imported_at: dir_imported_at(dir),
    })
}

/// id 用作目录名：只排除路径分隔符/.. 和前导点，允许中文等任意字符
pub(crate) fn valid_id(id: &str) -> bool {
    !id.is_empty() && !id.contains(['/', '\\']) && !id.contains("..") && !id.starts_with('.')
}

/// 目录/zip 名 → 合法 id：非法字符替换为 '-'，压缩连续点
fn sanitize_id(raw: &str) -> String {
    let cleaned: String = raw
        .trim()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    let collapsed = cleaned.replace("..", ".");
    let trimmed = collapsed.trim_matches('.').to_string();
    if trimmed.is_empty() {
        "petpack".into()
    } else {
        trimmed
    }
}

// ---------- 皮肤包命令 ----------

/// 读取皮肤包 manifest 里的换装名单（outfits[].name）；无 outfits 或读取失败返回空。
/// 名单只进右键菜单展示，参数应用由前端按 manifest.outfits 执行。
pub(crate) fn pack_outfit_names(app: &AppHandle, pack_id: &str) -> Vec<String> {
    let Ok(dir) = packs_dir(app) else { return vec![] };
    let Ok(text) = fs::read_to_string(dir.join(pack_id).join("petpack.json")) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return vec![] };
    v["outfits"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|o| o["name"].as_str().map(|n| n.to_string()))
                .collect()
        })
        .unwrap_or_default()
}


#[tauri::command]
pub fn list_user_petpacks(app: AppHandle) -> Result<Vec<PetpackInfo>, String> {
    let dir = packs_dir(&app)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        if p.is_dir()
            && p.join("petpack.json").exists()
            && let Ok(info) = read_manifest(&p)
        {
            out.push(info);
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

/// 依据 model3.json 内容生成默认 petpack.json 文本：
/// Idle 分组 → idle/walk/thinking/speaking/failed，TapBody（或第一个可用分组）→ 交互动作
fn build_live2d_manifest(id: &str, name: &str, entry: &str, m3_text: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(m3_text).map_err(|e| format!("model3.json 解析失败: {e}"))?;
    let groups: Vec<String> = v["FileReferences"]["Motions"]
        .as_object()
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    // 只绑定至少含一个 File 的动作组：解包模型常见空动作组（只有 Name/参数），
    // 绑定后播放必失败；纯 Sound 的语音组也不适合做待机循环
    let playable = |k: &str| {
        v["FileReferences"]["Motions"][k]
            .as_array()
            .map(|arr| arr.iter().any(|m| m["File"].as_str().is_some()))
            .unwrap_or(false)
    };
    let idle = if groups.iter().any(|k| k.as_str() == "Idle" && playable(k)) {
        "Idle".to_string()
    } else {
        groups
            .iter()
            .find(|k| playable(k.as_str()))
            .cloned()
            .or_else(|| groups.first().cloned())
            .unwrap_or_else(|| "Idle".to_string())
    };
    let tap = if playable("TapBody") {
        "TapBody".to_string()
    } else {
        idle.clone()
    };
    let obj = serde_json::json!({
        "id": id,
        "name": name,
        "version": "1.0.0",
        "engine": "live2d",
        "entry": entry,
        "animations": {
            "idle": { "motion": idle },
            "walk": { "motion": idle },
            "thinking": { "motion": idle },
            "speaking": { "motion": idle },
            "failed": { "motion": idle },
            "drag": { "motion": tap },
            "click": { "motion": tap },
            "done": { "motion": tap }
        },
        "generated": true
    });
    serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())
}

// ---------- 导入进度 ----------

/// 导入进度事件载荷（前端据此画顶部进度条）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImportProgress {
    done: usize,
    total: usize,
    /// 当前正在复制的文件名
    current: String,
}

/// 进度采样步长：>100 个文件的包每约 1% 发一条，控制事件洪水（纯函数，便于单测）
fn progress_step(total: usize) -> usize {
    (total / 100).max(1)
}

/// 是否该发一条进度（纯函数，便于单测）：前 5 条全发，之后按步长采样，最后一条必发
fn progress_due(done: usize, total: usize) -> bool {
    done >= total || done <= 5 || done.is_multiple_of(progress_step(total))
}

/// 导入过程计数器：每完成一个文件 tick 一次
struct ImportCtx<'a> {
    app: &'a AppHandle,
    total: usize,
    done: usize,
}

impl ImportCtx<'_> {
    fn tick(&mut self, current: &str) {
        self.done += 1;
        if progress_due(self.done, self.total) {
            let _ = self.app.emit(
                "import-progress",
                ImportProgress {
                    done: self.done,
                    total: self.total,
                    current: current.to_string(),
                },
            );
        }
    }
}

/// 递归统计目录里的文件数（导入前算总量，用于进度百分比）
fn count_files(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut n = 0;
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            n += count_files(&p);
        } else {
            n += 1;
        }
    }
    n
}

fn copy_dir(
    src: &Path,
    dest: &Path,
    budget: &mut usize,
    prog: &mut ImportCtx,
) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for e in fs::read_dir(src).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        if *budget == 0 {
            return Err("文件数量超过上限（10000）".into());
        }
        let name = p.file_name().ok_or("非法文件名")?.to_string_lossy().to_string();
        if p.is_dir() {
            copy_dir(&p, &dest.join(&name), budget, prog)?;
        } else {
            fs::copy(&p, dest.join(&name)).map_err(|e| e.to_string())?;
            *budget -= 1;
            prog.tick(&name);
        }
    }
    Ok(())
}

/// 在目录树里找第一个 *.model3.json（浅层优先），返回（绝对路径, 相对路径/）
fn find_model3(dir: &Path, base: &Path, depth: usize, out: &mut Option<(PathBuf, String)>) {
    if depth > 4 || out.is_some() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            subdirs.push(p);
            continue;
        }
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        if name.ends_with(".model3.json") {
            let rel = p
                .strip_prefix(base)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            *out = Some((p, rel));
            return;
        }
    }
    for d in subdirs {
        find_model3(&d, base, depth + 1, out);
        if out.is_some() {
            return;
        }
    }
}

/// 判断 JSON 文件内容是否为 Cubism 4 模型设置（与渲染库 pixi-live2d-display
/// 的判定一致：FileReferences.Moc 指向 .moc3 且 Textures 为非空字符串数组）。
/// 解包器输出的入口叫 model0.json 而非 xxx.model3.json，需按内容识别。
fn is_cubism4_settings(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else { return false };
    if meta.len() > 32 * 1024 * 1024 {
        return false;
    }
    let Ok(text) = fs::read_to_string(path) else { return false };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return false };
    let fr = &v["FileReferences"];
    fr["Moc"]
        .as_str()
        .map(|m| m.to_lowercase().ends_with(".moc3"))
        .unwrap_or(false)
        && fr["Textures"]
            .as_array()
            .map(|a| !a.is_empty() && a.iter().all(|t| t.is_string()))
            .unwrap_or(false)
}

/// model(N).json 的数字后缀，用于多个入口文件时按编号升序（model0 优先）
fn model_json_num(name: &str) -> Option<u32> {
    let stem = name.strip_suffix(".json")?;
    stem.strip_prefix("model")?.parse().ok()
}

/// 与 find_model3 相同的遍历方式，但按内容识别入口：
/// 同层多个候选时 model(N).json 按编号升序优先，其余按文件名排序保证确定性
fn find_cubism_json(dir: &Path, base: &Path, depth: usize, out: &mut Option<(PathBuf, String)>) {
    if depth > 4 || out.is_some() {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else { return };
    let mut jsons = Vec::new();
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if p
            .extension()
            .map(|x| x.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            jsons.push(p);
        }
    }
    jsons.sort_by_key(|p| {
        let name = p.file_name().unwrap_or_default().to_string_lossy().to_string();
        (model_json_num(&name).unwrap_or(u32::MAX), name)
    });
    for p in jsons {
        if is_cubism4_settings(&p) {
            let rel = p
                .strip_prefix(base)
                .unwrap_or(&p)
                .to_string_lossy()
                .replace('\\', "/");
            *out = Some((p, rel));
            return;
        }
    }
    subdirs.sort();
    for d in subdirs {
        find_cubism_json(&d, base, depth + 1, out);
        if out.is_some() {
            return;
        }
    }
}

/// 找 Live2D 模型入口：优先标准 *.model3.json 文件名，找不到再按内容识别
/// 解包器输出的 model*.json。返回（绝对路径, 相对路径）。
fn find_live2d_entry(dir: &Path, base: &Path) -> Option<(PathBuf, String)> {
    let mut out = None;
    find_model3(dir, base, 0, &mut out);
    if out.is_none() {
        find_cubism_json(dir, base, 0, &mut out);
    }
    out
}

/// 导入文件夹形式的 Live2D 模型：复制到 appData/petskins/<id>/，
/// 无 petpack.json 时依据 model3.json 自动生成。
/// 必须是 async：同步命令跑在主线程，上千文件的复制会卡住全部窗口事件。
#[tauri::command]
pub async fn import_model_folder(app: AppHandle, path: String) -> Result<PetpackInfo, String> {
    let src = PathBuf::from(&path);
    if !src.is_dir() {
        return Err(format!("不是文件夹: {path}"));
    }
    // 已带 petpack.json 的目录按皮肤包整体导入
    let has_manifest = src.join("petpack.json").is_file();
    if !has_manifest && find_live2d_entry(&src, &src).is_none() {
        return Err("文件夹中找不到 petpack.json 或 Live2D 模型（*.model3.json / 解包的 model*.json）".into());
    }
    let raw_name = src
        .file_name()
        .ok_or("无法获取文件夹名")?
        .to_string_lossy()
        .to_string();
    let id = sanitize_id(&raw_name);
    let dest = packs_dir(&app)?.join(&id);
    if dest.exists() {
        return Err(format!("皮肤包 {id} 已存在，请先删除旧包"));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    // 解包出的语音看板模型动辄 2000+ 文件（上千条语音 mp3），600 上限会误伤
    let mut budget = 10000usize;
    let mut prog = ImportCtx {
        app: &app,
        total: count_files(&src),
        done: 0,
    };
    // 复制失败（IO 错误/超上限）时清掉半成品目录，避免残留坏包挡住重试
    if let Err(e) = copy_dir(&src, &dest, &mut budget, &mut prog) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }

    if has_manifest {
        return read_manifest(&dest);
    }
    // 自动生成 petpack.json
    let (abs, rel) = find_live2d_entry(&src, &src).ok_or("找不到 Live2D 模型入口")?;
    let m3_text = fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let manifest = match build_live2d_manifest(&id, &raw_name, &rel, &m3_text) {
        Ok(m) => m,
        Err(e) => {
            let _ = fs::remove_dir_all(&dest);
            return Err(e);
        }
    };
    if let Err(e) = fs::write(dest.join("petpack.json"), manifest) {
        let _ = fs::remove_dir_all(&dest);
        return Err(e.to_string());
    }
    read_manifest(&dest)
}

/// 导入 zip 皮肤包：zip 内（根目录或唯一一级子目录）需有 petpack.json；
/// 没有 petpack.json 但有 Live2D 模型时自动生成默认清单。带 zip-slip 防护。
/// 必须是 async：同步命令跑在主线程，大 zip 解压会卡住全部窗口事件。
#[tauri::command]
pub async fn import_petpack(app: AppHandle, path: String) -> Result<PetpackInfo, String> {
    let zip_path = PathBuf::from(&path);
    if !zip_path.exists() {
        return Err(format!("文件不存在: {path}"));
    }
    let file = fs::File::open(&zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    // 扫描 zip：优先找 petpack.json；找不到则找 model3.json 准备自动生成
    let mut manifest_name: Option<String> = None;
    let mut model3_name: Option<String> = None;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| e.to_string())?
            .name()
            .to_string();
        if name.contains('\\') || name.matches('/').count() > 1 {
            continue;
        }
        let base = Path::new(&name)
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default();
        if manifest_name.is_none() && base == "petpack.json" {
            manifest_name = Some(name);
        } else if model3_name.is_none() && base.ends_with(".model3.json") {
            model3_name = Some(name);
        }
        if manifest_name.is_some() {
            break;
        }
    }

    let (manifest_text, prefix, auto_generated) = if let Some(m) = manifest_name {
        let mut text = String::new();
        {
            let mut f = archive.by_name(&m).map_err(|e| e.to_string())?;
            f.read_to_string(&mut text).map_err(|e| e.to_string())?;
        }
        let prefix = Path::new(&m)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_string();
        (text, prefix, None)
    } else if let Some(m) = model3_name {
        let stem = zip_path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "petpack".into());
        let id = sanitize_id(&stem);
        let mut text = String::new();
        {
            let mut f = archive.by_name(&m).map_err(|e| e.to_string())?;
            f.read_to_string(&mut text).map_err(|e| e.to_string())?;
        }
        let prefix = Path::new(&m)
            .parent()
            .and_then(|p| p.to_str())
            .unwrap_or("")
            .to_string();
        let entry_rel = Path::new(&m)
            .strip_prefix(if prefix.is_empty() { Path::new("") } else { Path::new(&prefix) })
            .unwrap_or(Path::new(&m))
            .to_string_lossy()
            .replace('\\', "/");
        let generated = build_live2d_manifest(&id, &stem, &entry_rel, &text)?;
        (generated, prefix, Some(id.clone()))
    } else {
        return Err("zip 中找不到 petpack.json 或 *.model3.json".into());
    };

    let id = match &auto_generated {
        Some(id) => id.clone(),
        None => {
            let v: serde_json::Value = serde_json::from_str(&manifest_text)
                .map_err(|e| format!("petpack.json 不是合法 JSON: {e}"))?;
            v["id"].as_str().ok_or("petpack.json 缺少 id")?.to_string()
        }
    };
    if !valid_id(&id) {
        return Err(format!("非法皮肤包 id: {id}"));
    }
    // 进度总量 = zip 内文件数（目录条目不计）；超上限直接拒绝（与文件夹导入一致）
    let total = (0..archive.len())
        .filter(|i| archive.by_index(*i).map(|f| !f.is_dir()).unwrap_or(false))
        .count();
    if total > 10000 {
        return Err("文件数量超过上限（10000）".into());
    }
    let dest = packs_dir(&app)?.join(&id);
    if dest.exists() {
        return Err(format!("皮肤包 {id} 已存在，请先删除旧包"));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;

    let mut prog = ImportCtx {
        app: &app,
        total,
        done: 0,
    };
    // 解压中途失败（IO 错误等）清掉半成品目录，避免残留坏包挡住重试
    let mut extract = || -> Result<(), String> {
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
            if f.is_dir() {
                continue;
            }
            let name = f.name().to_string();
            let rel = if prefix.is_empty() {
                name
            } else {
                match name.strip_prefix(&format!("{prefix}/")) {
                    Some(r) => r.to_string(),
                    None => continue, // 前缀之外的文件跳过
                }
            };
            if rel.is_empty() || rel.contains("..") || Path::new(&rel).is_absolute() {
                continue; // zip-slip 防护
            }
            let out_path = dest.join(&rel);
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            let mut out = fs::File::create(&out_path).map_err(|e| e.to_string())?;
            io::copy(&mut f, &mut out).map_err(|e| e.to_string())?;
            prog.tick(&rel);
        }
        if auto_generated.is_some() {
            fs::write(dest.join("petpack.json"), &manifest_text).map_err(|e| e.to_string())?;
        }
        Ok(())
    };
    if let Err(e) = extract() {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    read_manifest(&dest)
}

#[tauri::command]
pub async fn delete_petpack(app: AppHandle, id: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("非法皮肤包 id".into());
    }
    let dir = packs_dir(&app)?.join(&id);
    if !dir.exists() {
        return Err(format!("皮肤包 {id} 不存在"));
    }
    fs::remove_dir_all(&dir).map_err(|e| e.to_string())
}

// ---------- 皮肤封面 ----------

/// 已落盘封面的查找顺序：用户包目录 .cover.png → appData/covers/<id>.png（内置包）
/// （纯逻辑拆出，便于单测）
fn cover_file_path(packs_dir: &Path, app_data: &Path, id: &str) -> Option<PathBuf> {
    let in_pack = packs_dir.join(id).join(".cover.png");
    if in_pack.is_file() {
        return Some(in_pack);
    }
    let cached = app_data.join("covers").join(format!("{id}.png"));
    cached.is_file().then_some(cached)
}

/// 查找皮肤封面文件路径（不存在返回 None；前端用 asset 协议读取）
#[tauri::command]
pub fn pack_cover_path(app: AppHandle, id: String) -> Result<Option<String>, String> {
    if !valid_id(&id) {
        return Err("非法皮肤包 id".into());
    }
    let packs = packs_dir(&app)?;
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(cover_file_path(&packs, &app_data, &id)
        .map(|p| p.to_string_lossy().to_string()))
}

/// 封面解码与上限校验（纯函数，便于单测）：非空 PNG，≤200KB
fn decode_cover(data: &str) -> Result<Vec<u8>, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|e| format!("封面数据解码失败: {e}"))?;
    if bytes.is_empty() {
        return Err("封面数据为空".into());
    }
    if bytes.len() > 200 * 1024 {
        return Err(format!("封面过大（{}KB > 200KB）", bytes.len() / 1024));
    }
    Ok(bytes)
}

/// 保存前端生成的封面 PNG（base64）：用户包写入包内 .cover.png，
/// 否则（内置包）写入 appData/covers/<id>.png；返回落盘路径
#[tauri::command]
pub fn write_pack_cover(app: AppHandle, id: String, base64_data: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err("非法皮肤包 id".into());
    }
    let bytes = decode_cover(&base64_data)?;
    let target = {
        let packs = packs_dir(&app)?;
        if packs.join(&id).is_dir() {
            packs.join(&id).join(".cover.png")
        } else {
            let covers = app.path().app_data_dir().map_err(|e| e.to_string())?.join("covers");
            fs::create_dir_all(&covers).map_err(|e| e.to_string())?;
            covers.join(format!("{id}.png"))
        }
    };
    fs::write(&target, &bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().to_string())
}

// ---------- 包操作 ----------

/// 重命名皮肤包：只改写 petpack.json 的 name（id/目录不变）
#[tauri::command]
pub fn rename_petpack(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("名称不能为空".into());
    }
    if name.chars().count() > 64 {
        return Err("名称过长（最多 64 字符）".into());
    }
    let dir = packs_dir(&app)?.join(&id);
    if !dir.is_dir() {
        return Err(format!("皮肤包 {id} 不存在"));
    }
    let text = fs::read_to_string(dir.join("petpack.json"))
        .map_err(|e| format!("读取 petpack.json 失败: {e}"))?;
    let new_text = apply_pack_name(&text, &name)?;
    fs::write(dir.join("petpack.json"), new_text).map_err(|e| e.to_string())
}

/// 纯函数：把 petpack.json 文本里的 name 换成新值（保留其余字段与结构）
fn apply_pack_name(text: &str, name: &str) -> Result<String, String> {
    let mut v: serde_json::Value =
        serde_json::from_str(text).map_err(|e| format!("petpack.json 不是合法 JSON: {e}"))?;
    if v["id"].as_str().is_none() {
        return Err("petpack.json 缺少 id".into());
    }
    v["name"] = serde_json::Value::String(name.to_string());
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/// 递归把目录打成 zip（相对路径用 / 分隔）
fn zip_dir(
    dir: &Path,
    root: &Path,
    zw: &mut zip::ZipWriter<std::fs::File>,
) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default();
    for e in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let p = e.map_err(|e| e.to_string())?.path();
        let rel = p
            .strip_prefix(root)
            .unwrap_or(&p)
            .to_string_lossy()
            .replace('\\', "/");
        if p.is_dir() {
            zw.add_directory(rel.clone(), options)
                .map_err(|e| e.to_string())?;
            zip_dir(&p, root, zw)?;
        } else {
            zw.start_file(rel, options).map_err(|e| e.to_string())?;
            let mut f = fs::File::open(&p).map_err(|e| e.to_string())?;
            io::copy(&mut f, zw).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 导出用户皮肤包为 zip（用于分享/备份）。
/// async：同步命令跑在主线程，大包压缩会卡住全部窗口事件。
#[tauri::command]
pub async fn export_petpack(app: AppHandle, id: String, dest: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("非法皮肤包 id".into());
    }
    let src = packs_dir(&app)?.join(&id);
    if !src.is_dir() {
        return Err(format!("皮肤包 {id} 不存在"));
    }
    let file = fs::File::create(&dest).map_err(|e| e.to_string())?;
    let mut zw = zip::ZipWriter::new(file);
    zip_dir(&src, &src, &mut zw)?;
    zw.finish().map_err(|e| e.to_string())?;
    Ok(())
}

/// 由图片帧创建精灵图皮肤包（前端完成抽帧/拼 sheet，这里负责落盘）：
/// sheet 为 PNG base64；manifest 中的 id/name/sprite 元数据以此处参数为准。
#[tauri::command]
pub async fn create_sprite_pack(
    app: AppHandle,
    name: String,
    sheet_base64: String,
    frame_w: u32,
    frame_h: u32,
    cols: u32,
    mut manifest: String,
) -> Result<PetpackInfo, String> {
    if frame_w == 0 || frame_h == 0 || cols == 0 {
        return Err("帧尺寸/列数不合法".into());
    }
    let id = sanitize_id(&name);
    if !valid_id(&id) {
        return Err(format!("无法从名称生成合法 id: {name}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("manifest 不是合法 JSON: {e}"))?;
    if v["engine"].as_str() != Some("sprite") {
        return Err("manifest.engine 必须为 sprite".into());
    }
    if v["animations"]["idle"].is_null() {
        return Err("manifest 缺少 idle 动画".into());
    }
    // 强制对齐 id/name 与 sprite 元数据
    let mut obj = v;
    obj["id"] = serde_json::Value::String(id.clone());
    obj["name"] = serde_json::Value::String(name.clone());
    obj["sprite"]["sheet"] = serde_json::Value::String("sheet.png".into());
    obj["sprite"]["frameW"] = serde_json::Value::from(frame_w);
    obj["sprite"]["frameH"] = serde_json::Value::from(frame_h);
    obj["sprite"]["cols"] = serde_json::Value::from(cols);
    manifest = serde_json::to_string_pretty(&obj).map_err(|e| e.to_string())?;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(sheet_base64.trim())
        .map_err(|e| format!("sheet 图片解码失败: {e}"))?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err("sheet 图片过大（>32MB）".into());
    }
    let dest = packs_dir(&app)?.join(&id);
    if dest.exists() {
        return Err(format!("皮肤包 {id} 已存在，请先删除旧包"));
    }
    fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
    let write = || -> Result<(), String> {
        fs::write(dest.join("sheet.png"), &bytes).map_err(|e| e.to_string())?;
        fs::write(dest.join("petpack.json"), &manifest).map_err(|e| e.to_string())?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = fs::remove_dir_all(&dest);
        return Err(e);
    }
    read_manifest(&dest)
}

/// 皮肤编辑器保存：覆写 petpack.json（校验 JSON/id/engine）
#[tauri::command]
pub fn write_pack_manifest(app: AppHandle, id: String, manifest: String) -> Result<(), String> {
    if !valid_id(&id) {
        return Err("非法皮肤包 id".into());
    }
    let dir = packs_dir(&app)?.join(&id);
    if !dir.is_dir() {
        return Err(format!("皮肤包 {id} 不存在"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&manifest).map_err(|e| format!("petpack.json 不是合法 JSON: {e}"))?;
    if v["id"].as_str() != Some(id.as_str()) {
        return Err("manifest.id 与皮肤包不一致".into());
    }
    if !matches!(v["engine"].as_str(), Some("live2d") | Some("sprite")) {
        return Err("engine 不合法".into());
    }
    let text = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    fs::write(dir.join("petpack.json"), text).map_err(|e| e.to_string())
}

/// 复制音频文件进皮肤包 sounds/ 目录，返回包内相对路径
#[tauri::command]
pub async fn add_pack_sound(app: AppHandle, id: String, path: String) -> Result<String, String> {
    if !valid_id(&id) {
        return Err("非法皮肤包 id".into());
    }
    let src = PathBuf::from(&path);
    if !src.is_file() {
        return Err(format!("文件不存在: {path}"));
    }
    let dir = packs_dir(&app)?.join(&id);
    if !dir.is_dir() {
        return Err(format!("皮肤包 {id} 不存在"));
    }
    let sounds = dir.join("sounds");
    fs::create_dir_all(&sounds).map_err(|e| e.to_string())?;
    let name = src
        .file_name()
        .ok_or("非法文件名")?
        .to_string_lossy()
        .to_string();
    fs::copy(&src, sounds.join(&name)).map_err(|e| e.to_string())?;
    Ok(format!("sounds/{name}"))
}

/// 读取用户选择的文件为 base64（导入图片/GIF 用；上限 64MB）。
/// async：同步命令跑在主线程，64MB 读盘+编码会卡住全部窗口事件。
#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("文件过大（>64MB）".into());
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY: &str = r##"{
      "activePetpack": "panda.incense",
      "lockPosition": true,
      "alwaysOnTop": false,
      "soundEnabled": false,
      "bubbleEnabled": false,
      "roamEnabled": false,
      "walkFreq": "lively",
      "walkSpeed": 80,
      "volume": 0.4,
      "bubbleMs": 3200,
      "window": { "x": 10, "y": 20, "scale": 0.7 }
    }"##;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pet-settings-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn migrate_v1_single_pet() {
        let s = migrate_settings(parse_settings(LEGACY).unwrap());
        assert_eq!(s.pets.len(), 1);
        let p = &s.pets[0];
        assert_eq!(p.id, "pet-1");
        assert_eq!(p.petpack.as_deref(), Some("panda.incense"));
        assert_eq!((p.x, p.y), (Some(10), Some(20)));
        assert_eq!(p.scale, Some(0.7));
        assert!(p.lock_position);
        assert!(!p.roam_enabled);
        assert!(!p.sound_enabled);
        assert!(!p.bubble_enabled);
        assert!(!p.always_on_top);
        assert_eq!(p.walk_freq, "lively");
        assert_eq!(p.walk_speed, 80.0);
        assert!((s.volume - 0.4).abs() < 1e-9);
        assert_eq!(s.bubble_ms, 3200);
    }

    #[test]
    fn migrated_settings_drops_legacy_fields() {
        let s = migrate_settings(parse_settings(LEGACY).unwrap());
        let text = serde_json::to_string(&s).unwrap();
        assert!(text.contains("\"pets\""));
        assert!(!text.contains("activePetpack"));
        assert!(!text.contains("\"window\""));
        let again = parse_settings(&text).unwrap();
        assert_eq!(again.pets.len(), 1);
        assert_eq!(again.pets[0].petpack.as_deref(), Some("panda.incense"));
    }

    #[test]
    fn new_format_round_trip() {
        let mut s = Settings::default();
        s.pets.push(Pet {
            id: "pet-2".into(),
            petpack: Some("slime.pixel".into()),
            display_name: Some("小白".into()),
            x: Some(1),
            y: Some(2),
            scale: Some(1.5),
            ..Default::default()
        });
        s.volume = 0.8;
        s.bubble_ms = 1000;
        let text = serde_json::to_string(&s).unwrap();
        let back = parse_settings(&text).unwrap();
        assert_eq!(back.pets.len(), 1);
        assert_eq!(back.pets[0].id, "pet-2");
        assert_eq!(back.pets[0].scale, Some(1.5));
        assert_eq!(back.pets[0].display_name.as_deref(), Some("小白"));
        assert!((back.volume - 0.8).abs() < 1e-9);
        assert_eq!(back.bubble_ms, 1000);
    }

    #[test]
    fn display_name_missing_is_none() {
        // 旧版设置没有 displayName 字段 → None（前端回退「皮肤名 · 序号」）
        let legacy = r#"{"pets": [{"id": "pet-1", "petpack": "slime.pixel"}]}"#;
        let s = parse_settings(legacy).unwrap();
        assert_eq!(s.pets[0].display_name, None);
    }

    #[test]
    fn ambient_enabled_defaults_true_and_persists_false() {
        // 旧设置文件没有 ambientEnabled 字段 → 默认开启
        let legacy = r#"{"pets": [{"id": "pet-1"}], "volume": 0.6, "bubbleMs": 2600}"#;
        let s = parse_settings(legacy).unwrap();
        assert!(s.pets[0].ambient_enabled);
        // 显式关闭后写回再读，保持关闭
        let mut s2 = Settings::default();
        s2.pets.push(Pet::new("pet-1"));
        s2.pets[0].ambient_enabled = false;
        let text = serde_json::to_string(&s2).unwrap();
        let back = parse_settings(&text).unwrap();
        assert!(!back.pets[0].ambient_enabled);
    }

    #[test]
    fn ground_enabled_defaults_true_and_persists_false() {
        // 旧设置文件没有 groundEnabled 字段 → 默认开启（任务栏模式）
        let legacy = r#"{"pets": [{"id": "pet-1"}]}"#;
        let s = parse_settings(legacy).unwrap();
        assert!(s.pets[0].ground_enabled);
        // 显式关闭后写回再读，保持关闭
        let mut s2 = Settings::default();
        s2.pets.push(Pet::new("pet-1"));
        s2.pets[0].ground_enabled = false;
        let text = serde_json::to_string(&s2).unwrap();
        let back = parse_settings(&text).unwrap();
        assert!(!back.pets[0].ground_enabled);
    }

    #[test]
    fn invalid_json_errors() {
        assert!(parse_settings("{not json}").is_err());
    }

    #[test]
    fn physics_and_ambient_defaults() {
        // 旧设置文件没有这些字段 → 手感参数取默认值
        let s = parse_settings(r#"{"pets": [{"id": "pet-1"}]}"#).unwrap();
        assert_eq!(s.gravity, 3000.0);
        assert_eq!(s.bounce_restitution, 0.45);
        assert_eq!(s.fling_min_speed, 220.0);
        assert_eq!(s.ambient_interval_sec, 40);
    }

    #[test]
    fn existing_pets_are_not_migrated_again() {
        let mut s = Settings::default();
        s.pets.push(Pet::new("pet-9"));
        let out = migrate_settings(s);
        assert_eq!(out.pets.len(), 1);
        assert_eq!(out.pets[0].id, "pet-9");
    }

    #[test]
    fn next_pet_id_skips_used_ids() {
        let mut s = Settings::default();
        s.pets.push(Pet::new("pet-1"));
        s.pets.push(Pet::new("pet-3"));
        assert_eq!(next_pet_id(&s), "pet-2");
        s.pets.push(Pet::new("pet-2"));
        assert_eq!(next_pet_id(&s), "pet-4");
    }

    #[test]
    fn builtin_packs_include_panda() {
        let packs = builtin_packs();
        assert!(packs
            .iter()
            .any(|(id, name)| id == "panda.incense" && name == "上香熊猫"));
        assert!(packs.iter().any(|(id, _)| id == "hiyori.live2d"));
    }

    #[test]
    fn pack_id_rules() {
        assert!(valid_id("panda.incense"));
        assert!(valid_id("user-pack_1"));
        assert!(!valid_id(""));
        assert!(!valid_id("../evil"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id(".hidden"));
    }

    #[test]
    fn atomic_write_reads_back() {
        let dir = temp_dir("atomic");
        let path = dir.join("settings.json");
        let mut s = Settings::default();
        s.pets.push(Pet::new("pet-1"));
        s.volume = 0.25;
        write_settings_file(&path, &s).unwrap();
        let back = read_settings_file(&path).unwrap();
        assert_eq!(back.pets.len(), 1);
        assert!((back.volume - 0.25).abs() < 1e-9);
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_file_is_default() {
        let dir = temp_dir("missing");
        let back = read_settings_file(&dir.join("nope.json")).unwrap();
        assert!(back.pets.is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    // ---- Live2D 模型入口检测（解包器 model*.json 按内容识别）----

    fn write_file(dir: &Path, name: &str, text: &str) {
        fs::write(dir.join(name), text).unwrap();
    }

    const CUBISM4_ENTRY: &str = r#"{"Version":3,"FileReferences":{"Moc":"Moc_0.moc3","Textures":["Textures_0_0.png"],"Motions":{"face":[{"File":"Motions_face_1_File_0.json"}]}}}"#;

    #[test]
    fn find_entry_prefers_model3_name_over_content() {
        let dir = temp_dir("prefer-name");
        write_file(&dir, "model0.json", CUBISM4_ENTRY);
        write_file(&dir, "Hiyori.model3.json", CUBISM4_ENTRY);
        let found = find_live2d_entry(&dir, &dir);
        assert_eq!(found.unwrap().1, "Hiyori.model3.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_entry_detects_unpacked_model0_json() {
        let dir = temp_dir("unpacked");
        write_file(&dir, "model0.json", CUBISM4_ENTRY);
        write_file(&dir, "Physics_0.json", r#"{"PhysicsSettings":[]}"#);
        write_file(&dir, "Motions_face_1_File_0.json", r#"{"Meta":{},"Curves":[]}"#);
        let found = find_live2d_entry(&dir, &dir);
        assert_eq!(found.unwrap().1, "model0.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_entry_rejects_cubism2_and_spine() {
        let dir = temp_dir("reject");
        write_file(&dir, "model.json", r#"{"model":"x.moc","textures":["t.png"]}"#);
        write_file(&dir, "skeleton_0.json", r#"{"skeleton":{"hash":"x"}}"#);
        assert!(find_live2d_entry(&dir, &dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_entry_picks_lowest_numbered_model() {
        let dir = temp_dir("numbered");
        write_file(&dir, "model10.json", CUBISM4_ENTRY);
        write_file(&dir, "model2.json", CUBISM4_ENTRY);
        write_file(&dir, "model0.pretty.json", CUBISM4_ENTRY);
        let found = find_live2d_entry(&dir, &dir);
        // 按数值升序：model2 先于 model10；无数字后缀的 model0.pretty 排最后
        assert_eq!(found.unwrap().1, "model2.json");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn manifest_skips_groups_without_motion_files() {
        // Doro：TapBody 只有 Name/参数没有 File → 交互动作回退 Idle
        let m3 = r#"{"FileReferences":{"Motions":{
            "Idle":[{"File":"Motions_Idle_0_File_0.json","FileLoop":true}],
            "TapBody":[{"Name":"Running OFF","VarFloats":" "}]}}}"#;
        let text = build_live2d_manifest("doro", "Doro", "model0.json", m3).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["animations"]["idle"]["motion"], "Idle");
        assert_eq!(v["animations"]["click"]["motion"], "Idle");
    }

    #[test]
    fn manifest_prefers_playable_group_when_no_idle() {
        // ATRI：无 Idle；voice 组只有 Sound → 待机取字典序第一个带 File 的组
        let m3 = r#"{"FileReferences":{"Motions":{
            "voice":[{"Sound":"Motions_voice_0_Sound_0.mp3"}],
            "hair":[{"File":"Motions_hair_0_File_0.json"}],
            "face":[{"File":"Motions_hair_0_File_0.json"}]}}}"#;
        let text = build_live2d_manifest("atri", "ATRI", "model0.json", m3).unwrap();
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["animations"]["idle"]["motion"], "face");
        assert_eq!(v["animations"]["drag"]["motion"], "face");
    }

    // ---- 导入进度采样 ----

    #[test]
    fn progress_emits_all_for_small_batches() {
        // 小包（≤100 文件）逐条发，空包与最后一条必发
        assert!(progress_due(1, 8));
        assert!(progress_due(8, 8));
        assert!(progress_due(0, 0));
    }

    #[test]
    fn progress_throttles_large_batches() {
        // 2000 文件：步长 20，第 6/7 条不发，第 20 条发，最后一条必发
        assert!(progress_due(5, 2000));
        assert!(!progress_due(6, 2000));
        assert!(!progress_due(7, 2000));
        assert!(progress_due(20, 2000));
        assert!(progress_due(2000, 2000));
        assert_eq!(progress_step(0), 1);
        assert_eq!(progress_step(2000), 20);
    }

    // ---- 封面存取 ----

    #[test]
    fn cover_path_prefers_pack_dir_over_cache() {
        let dir = temp_dir("cover");
        let packs = dir.join("petskins");
        let app_data = dir.join("appdata");
        fs::create_dir_all(packs.join("mypack")).unwrap();
        fs::create_dir_all(app_data.join("covers")).unwrap();
        // 都不存在 → None
        assert!(cover_file_path(&packs, &app_data, "mypack").is_none());
        // 只有 covers 缓存 → 取缓存
        fs::write(app_data.join("covers").join("mypack.png"), b"png").unwrap();
        assert_eq!(
            cover_file_path(&packs, &app_data, "mypack").unwrap(),
            app_data.join("covers").join("mypack.png")
        );
        // 包内出现 .cover.png 后优先包内
        fs::write(packs.join("mypack").join(".cover.png"), b"png").unwrap();
        assert_eq!(
            cover_file_path(&packs, &app_data, "mypack").unwrap(),
            packs.join("mypack").join(".cover.png")
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cover_decode_rejects_oversize_and_empty() {
        let data = base64::engine::general_purpose::STANDARD.encode(vec![0x89u8, b'P', b'N', b'G']);
        assert_eq!(decode_cover(&data).unwrap().len(), 4);
        assert!(decode_cover(" !!!not-base64!!! ").is_err());
        assert!(decode_cover("").is_err());
        let big = base64::engine::general_purpose::STANDARD.encode(vec![0u8; 200 * 1024 + 1]);
        assert!(decode_cover(&big).is_err());
    }

    // ---- 重命名 ----

    #[test]
    fn rename_updates_only_name_field() {
        let text = r#"{
  "id": "mypack",
  "name": "旧名",
  "engine": "sprite",
  "animations": { "idle": { "frames": [0] } }
}"#;
        let out = apply_pack_name(text, "新名").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["name"], "新名");
        assert_eq!(v["id"], "mypack");
        assert_eq!(v["engine"], "sprite");
        assert!(v["animations"]["idle"].is_object());
        assert!(apply_pack_name("{\"engine\":\"sprite\"}", "x").is_err());
        assert!(apply_pack_name("not json", "x").is_err());
    }
}
