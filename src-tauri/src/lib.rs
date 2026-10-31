mod petpack;

use petpack::{Pet, Settings};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

/// 同时显示的桌宠上限（每只桌宠 = 一个 WebView + 独立渲染器）
const MAX_PETS: usize = 6;
/// 重置位置时的默认落点（物理像素）
const RESET_POS: (i32, i32) = (120, 120);

/// 一次 IPC 返回点击穿透检测所需的全部信息，避免前端多次往返
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HitContext {
    cursor_x: f64,
    cursor_y: f64,
    win_x: i32,
    win_y: i32,
    scale: f64,
}

#[tauri::command]
fn hit_context(window: WebviewWindow) -> Result<HitContext, String> {
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    Ok(HitContext {
        cursor_x: cursor.x,
        cursor_y: cursor.y,
        win_x: pos.x,
        win_y: pos.y,
        scale,
    })
}

// ---------- 多桌宠窗口管理 ----------

fn show_all_pets(app: &AppHandle) {
    for pet in petpack::load_settings(app).pets {
        if let Some(w) = app.get_webview_window(&pet.id) {
            let _ = w.show();
        }
    }
}

fn hide_all_pets(app: &AppHandle) {
    for pet in petpack::load_settings(app).pets {
        if let Some(w) = app.get_webview_window(&pet.id) {
            let _ = w.hide();
        }
    }
    if let Some(b) = app.get_webview_window("bubble") {
        let _ = b.hide();
    }
    if let Some(state) = app.try_state::<BubbleOwner>()
        && let Ok(mut g) = state.0.lock()
    {
        *g = None;
    }
}

fn create_pet_window(app: &AppHandle, pet: &Pet, always_on_top: bool) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, &pet.id, WebviewUrl::default())
        .title("Pet")
        .inner_size(420.0, 540.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(always_on_top)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .visible(false)
        .focused(false)
        .build()?;
    let _ = win.set_ignore_cursor_events(true);
    Ok(win)
}

/// 必须是 async：同步命令在主线程上执行，而 run_on_main_thread 在主线程上
/// 是内联立即执行（不走事件队列）——在 IPC 处理器里同步建窗会重入消息循环，
/// Windows 上直接卡死整个应用。async 命令跑在运行时线程，建窗任务才会真正
/// 排队到事件循环回调里执行（与 setup 启动路径一致）。
fn create_pet_window_later(app: &AppHandle, pet: Pet, always_on_top: bool) {
    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Err(e) = create_pet_window(&app2, &pet, always_on_top) {
            eprintln!("创建桌宠窗口失败: {e}");
        }
    });
}

/// 新桌宠的默认落点：主屏右下角，按序号错开
fn default_pet_pos(app: &AppHandle, index: usize) -> (i32, i32) {
    if let Ok(Some(m)) = app.primary_monitor() {
        let area = m.work_area();
        let p = &area.position;
        let s = &area.size;
        let stagger = (index as i32 % 3) * 36;
        let x = p.x + s.width as i32 - 470 - stagger;
        let y = p.y + s.height as i32 - 590 - stagger;
        (x.max(p.x), y.max(p.y))
    } else {
        (RESET_POS.0 + index as i32 * 36, RESET_POS.1 + index as i32 * 36)
    }
}

/// 追加一条桌宠记录（不建窗口）；source 有值时复制其偏好
fn add_pet_record(
    app: &AppHandle,
    petpack: Option<String>,
    source: Option<&Pet>,
) -> Result<Pet, String> {
    let pet = petpack::with_settings(app, |s| {
        if s.pets.len() >= MAX_PETS {
            return Err(format!("最多同时显示 {MAX_PETS} 只桌宠"));
        }
        if let Some(pack) = &petpack
            && !petpack::valid_id(pack)
        {
            return Err("非法皮肤包 id".into());
        }
        let id = petpack::next_pet_id(s);
        let mut pet = Pet::new(id);
        if let Some(src) = source {
            pet.petpack = src.petpack.clone();
            pet.scale = src.scale;
            pet.lock_position = src.lock_position;
            pet.roam_enabled = src.roam_enabled;
            pet.sound_enabled = src.sound_enabled;
            pet.bubble_enabled = src.bubble_enabled;
            pet.ambient_enabled = src.ambient_enabled;
            pet.fling_enabled = src.fling_enabled;
            pet.gaze_enabled = src.gaze_enabled;
            pet.follow_enabled = src.follow_enabled;
            pet.ground_enabled = src.ground_enabled;
            pet.outfit_index = src.outfit_index;
            pet.always_on_top = src.always_on_top;
            pet.walk_freq = src.walk_freq.clone();
            pet.walk_speed = src.walk_speed;
            pet.x = Some(src.x.unwrap_or(RESET_POS.0) + 48);
            pet.y = Some(src.y.unwrap_or(RESET_POS.1) + 48);
        } else {
            pet.petpack = petpack;
            let (x, y) = default_pet_pos(app, s.pets.len());
            pet.x = Some(x);
            pet.y = Some(y);
        }
        s.pets.push(pet.clone());
        Ok(pet)
    })?;
    let _ = app.emit("pets-changed", ());
    Ok(pet)
}

/// 在主线程创建窗口（命令线程不能直接建窗，Windows 上会死锁）


#[tauri::command]
fn get_settings(app: AppHandle) -> Settings {
    petpack::load_settings(&app)
}

/// 当前实际可见的桌宠窗口 id 集合（设置页宠物卡片的"在线"小绿点用）
#[tauri::command]
fn pet_visibility(app: AppHandle) -> Vec<String> {
    petpack::load_settings(&app)
        .pets
        .iter()
        .filter(|p| {
            app.get_webview_window(&p.id)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false)
        })
        .map(|p| p.id.clone())
        .collect()
}

/// 必须是 async：同步命令在主线程执行，经 create_pet_window_later 建窗会死锁
/// （见 create_pet_window_later 的注释）。
#[tauri::command]
async fn add_pet(app: AppHandle, petpack: Option<String>) -> Result<Pet, String> {
    let pet = add_pet_record(&app, petpack, None)?;
    let on_top = petpack::load_settings(&app).always_on_top;
    create_pet_window_later(&app, pet.clone(), on_top);
    Ok(pet)
}

/// 必须是 async：同 add_pet（设置页「复制」按钮会触发建窗）。
#[tauri::command]
async fn duplicate_pet(app: AppHandle, id: String) -> Result<Pet, String> {
    let src = petpack::load_settings(&app)
        .pets
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("桌宠不存在")?;
    let pet = add_pet_record(&app, None, Some(&src))?;
    let on_top = petpack::load_settings(&app).always_on_top;
    create_pet_window_later(&app, pet.clone(), on_top);
    Ok(pet)
}

/// 必须是 async：关闭窗口属窗口生命周期操作，与建窗同理由（避免主线程内联派发）。
#[tauri::command]
async fn remove_pet(app: AppHandle, id: String) -> Result<(), String> {
    petpack::with_settings(&app, |s| {
        if s.pets.len() <= 1 {
            return Err("至少保留一只桌宠".into());
        }
        if !s.pets.iter().any(|p| p.id == id) {
            return Err("桌宠不存在".into());
        }
        s.pets.retain(|p| p.id != id);
        Ok(())
    })?;
    if let Some(w) = app.get_webview_window(&id) {
        let _ = w.close();
    }
    // 被移除的桌宠如果正占着共享气泡，立即收起
    let owns_bubble = app
        .state::<BubbleOwner>()
        .0
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .as_deref()
        == Some(id.as_str());
    if owns_bubble {
        if let Some(b) = app.get_webview_window("bubble") {
            let _ = b.hide();
        }
        if let Ok(mut g) = app.state::<BubbleOwner>().0.lock() {
            *g = None;
        }
    }
    let _ = app.emit("pets-changed", ());
    Ok(())
}

/// 每宠设置补丁：只更新传入的字段（数值做范围收敛）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PetPatch {
    pub petpack: Option<String>,
    pub display_name: Option<String>,
    pub scale: Option<f64>,
    pub lock_position: Option<bool>,
    pub roam_enabled: Option<bool>,
    pub sound_enabled: Option<bool>,
    pub bubble_enabled: Option<bool>,
    pub ambient_enabled: Option<bool>,
    pub fling_enabled: Option<bool>,
    pub gaze_enabled: Option<bool>,
    pub follow_enabled: Option<bool>,
    pub ground_enabled: Option<bool>,
    pub always_on_top: Option<bool>,
    pub walk_freq: Option<String>,
    pub walk_speed: Option<f64>,
    pub outfit_index: Option<u32>,
}

/// 轻量查询某只桌宠当前服装序号（前端 2s 自愈同步用，避免整份设置往返）
#[tauri::command]
fn get_pet_outfit(app: AppHandle, id: String) -> u32 {
    petpack::load_settings(&app)
        .pets
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.outfit_index)
        .unwrap_or(0)
}

#[tauri::command]
fn update_pet(app: AppHandle, id: String, patch: PetPatch) -> Result<Pet, String> {
    let top = patch.always_on_top;
    let pet = petpack::with_settings(&app, |s| {
        let pet = s
            .pets
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or("桌宠不存在")?;
        if let Some(v) = patch.petpack {
            if !petpack::valid_id(&v) {
                return Err("非法皮肤包 id".into());
            }
            // 服装选择跟着皮肤走：换包后旧序号可能指到新包别的衣服（或越界），回默认装
            if pet.petpack.as_deref() != Some(v.as_str()) {
                pet.outfit_index = 0;
            }
            pet.petpack = Some(v);
        }
        if let Some(v) = patch.display_name {
            let trimmed = v.trim().to_string();
            if trimmed.chars().count() > 64 {
                return Err("名称过长（最多 64 字符）".into());
            }
            // 空串 = 清除自定义名，回退「皮肤名 · 序号」
            pet.display_name = if trimmed.is_empty() { None } else { Some(trimmed) };
        }
        if let Some(v) = patch.scale {
            pet.scale = Some(v.clamp(0.2, 3.0));
        }
        if let Some(v) = patch.lock_position {
            pet.lock_position = v;
        }
        if let Some(v) = patch.roam_enabled {
            pet.roam_enabled = v;
        }
        if let Some(v) = patch.sound_enabled {
            pet.sound_enabled = v;
        }
        if let Some(v) = patch.bubble_enabled {
            pet.bubble_enabled = v;
        }
        if let Some(v) = patch.ambient_enabled {
            pet.ambient_enabled = v;
        }
        if let Some(v) = patch.fling_enabled {
            pet.fling_enabled = v;
        }
        if let Some(v) = patch.gaze_enabled {
            pet.gaze_enabled = v;
        }
        if let Some(v) = patch.follow_enabled {
            pet.follow_enabled = v;
        }
        if let Some(v) = patch.ground_enabled {
            pet.ground_enabled = v;
        }
        if let Some(v) = patch.always_on_top {
            pet.always_on_top = v;
        }
        if let Some(v) = patch.walk_freq {
            if !matches!(v.as_str(), "quiet" | "normal" | "lively") {
                return Err(format!("不支持的走动频率: {v}"));
            }
            pet.walk_freq = v;
        }
        if let Some(v) = patch.walk_speed {
            pet.walk_speed = v.clamp(20.0, 200.0);
        }
        if let Some(v) = patch.outfit_index {
            pet.outfit_index = v;
        }
        Ok(pet.clone())
    })?;
    if let Some(on) = top
        && let Some(w) = app.get_webview_window(&id)
    {
        let _ = w.set_always_on_top(on);
    }
    let _ = app.emit("pet-changed", &pet);
    Ok(pet)
}

/// 全局设置补丁：只更新传入的字段（数值做范围收敛）
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPrefsPatch {
    pub volume: Option<f64>,
    pub bubble_ms: Option<u64>,
    pub always_on_top: Option<bool>,
    pub gravity: Option<f64>,
    pub bounce_restitution: Option<f64>,
    pub fling_min_speed: Option<f64>,
    pub ambient_interval_sec: Option<u64>,
}

#[tauri::command]
fn update_global_prefs(app: AppHandle, patch: GlobalPrefsPatch) -> Result<Settings, String> {
    let s = petpack::with_settings(&app, |s| {
        if let Some(v) = patch.volume {
            s.volume = v.clamp(0.0, 1.0);
        }
        if let Some(v) = patch.bubble_ms {
            s.bubble_ms = v.clamp(500, 10_000);
        }
        if let Some(v) = patch.always_on_top {
            s.always_on_top = v;
        }
        if let Some(v) = patch.gravity {
            s.gravity = v.clamp(1000.0, 8000.0);
        }
        if let Some(v) = patch.bounce_restitution {
            s.bounce_restitution = v.clamp(0.0, 0.8);
        }
        if let Some(v) = patch.fling_min_speed {
            s.fling_min_speed = v.clamp(100.0, 500.0);
        }
        if let Some(v) = patch.ambient_interval_sec {
            s.ambient_interval_sec = v.clamp(15, 180);
        }
        Ok(s.clone())
    })?;
    if let Some(on) = patch.always_on_top {
        for pet in &s.pets {
            if let Some(w) = app.get_webview_window(&pet.id) {
                let _ = w.set_always_on_top(on);
            }
        }
    }
    let _ = app.emit(
        "global-prefs-changed",
        serde_json::json!({
            "volume": s.volume,
            "bubbleMs": s.bubble_ms,
            "alwaysOnTop": s.always_on_top,
            "gravity": s.gravity,
            "bounceRestitution": s.bounce_restitution,
            "flingMinSpeed": s.fling_min_speed,
            "ambientIntervalSec": s.ambient_interval_sec
        }),
    );
    Ok(s)
}

/// 保存某只桌宠的窗口状态（位置物理像素 + 缩放）；窗口 label 即 pet id
#[tauri::command]
fn save_pet_state(
    app: AppHandle,
    id: String,
    x: Option<i32>,
    y: Option<i32>,
    scale: Option<f64>,
) -> Result<(), String> {
    petpack::with_settings(&app, |s| {
        let Some(pet) = s.pets.iter_mut().find(|p| p.id == id) else {
            return Ok(());
        };
        if let Some(v) = x {
            pet.x = Some(v);
        }
        if let Some(v) = y {
            pet.y = Some(v);
        }
        if let Some(v) = scale {
            pet.scale = Some(v.clamp(0.2, 3.0));
        }
        Ok(())
    })
}

#[tauri::command]
fn reset_pet_position(app: AppHandle, id: String) -> Result<(), String> {
    let (x, y) = app
        .get_webview_window(&id)
        .and_then(|w| w.current_monitor().ok().flatten())
        .or(app.primary_monitor().ok().flatten())
        .map(|m| {
            let area = m.work_area();
            (area.position.x + 32, area.position.y + 32)
        })
        .unwrap_or(RESET_POS);
    petpack::with_settings(&app, |s| {
        let Some(pet) = s.pets.iter_mut().find(|p| p.id == id) else {
            return Err("桌宠不存在".into());
        };
        pet.x = Some(x);
        pet.y = Some(y);
        Ok(())
    })?;
    let _ = app.emit(
        "pet-moved",
        serde_json::json!({ "id": id, "x": x, "y": y }),
    );
    Ok(())
}

// ---------- 菜单 ----------

/// 设置窗口的“聚焦某只桌宠”暂存（窗口尚未创建时由其启动后取走）
#[derive(Default)]
struct SettingsFocus(Mutex<Option<String>>);

/// 气泡当前归属的桌宠：多只桌宠先后弹气泡时，旧桌宠的定时隐藏不会误关新气泡
#[derive(Default)]
struct BubbleOwner(Mutex<Option<String>>);

#[tauri::command]
fn take_settings_focus(state: tauri::State<SettingsFocus>) -> Option<String> {
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// 托盘菜单：作用于全部桌宠
fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "show_all", "显示全部桌宠", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide_all", "隐藏全部桌宠", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    Menu::with_items(app, &[&show, &hide, &settings, &sep, &quit])
}

// ---------- 桌宠右键菜单（HTML 菜单窗口渲染，动作复用 handle_menu） ----------

/// 菜单里的一个可点条目；action 串与原生命令时代一致（scale/skin/toggle/reset/hide/dup/settings/show_all/quit）
#[derive(Clone, Serialize)]
struct MenuEntry {
    label: String,
    action: String,
    checked: bool,
    danger: bool,
}

#[derive(Clone, Serialize)]
struct PetMenuData {
    /// 标题（桌宠名）
    name: String,
    /// 当前缩放百分比
    scale: i32,
    scales: Vec<MenuEntry>,
    /// 换装选项（皮肤包无 outfits 时为空；首项固定「默认」）
    outfits: Vec<MenuEntry>,
    toggles: Vec<MenuEntry>,
    actions: Vec<MenuEntry>,
    footer: Vec<MenuEntry>,
}

fn entry(label: impl Into<String>, action: impl Into<String>, checked: bool) -> MenuEntry {
    MenuEntry {
        label: label.into(),
        action: action.into(),
        checked,
        danger: false,
    }
}

/// 组装某只桌宠的菜单数据；action 串格式与 handle_menu 的解析一一对应
fn build_pet_menu_data(app: &AppHandle, id: &str) -> PetMenuData {
    let current = petpack::load_settings(app);
    let Some(pet) = current.pets.iter().find(|p| p.id == id) else {
        return PetMenuData {
            name: format!("桌宠 {id}"),
            scale: 100,
            scales: vec![],
            outfits: vec![],
            toggles: vec![],
            actions: vec![],
            footer: vec![
                entry("更多设置…", "settings", false),
                entry("退出", "quit", false),
            ],
        };
    };
    let pet = pet.clone();
    let pct = (pet.scale.unwrap_or(1.0) * 100.0).round() as i32;

    let scales = [50, 75, 100, 125, 150, 200]
        .into_iter()
        .map(|p| entry(format!("{p}%"), format!("scale:{id}:{p}"), (pct - p).abs() <= 1))
        .collect();


    // 皮肤名只用于标题（换皮肤走设置页，菜单不列皮肤）
    let mut all = petpack::builtin_packs();
    let users = petpack::list_user_petpacks(app.clone()).unwrap_or_default();
    all.retain(|(pid, _)| !users.iter().any(|u| &u.id == pid));
    all.extend(users.into_iter().map(|u| (u.id, u.name)));
    let effective = pet
        .petpack
        .clone()
        .or_else(|| all.first().map(|(pid, _)| pid.clone()));
    let pack_name = all
        .iter()
        .find(|(pid, _)| effective.as_deref() == Some(pid.as_str()))
        .map(|(_, n)| n.clone());


    // 换装：读当前皮肤包 manifest 的 outfits 名单（outfit_index 0 = 默认）
    let mut outfits = vec![entry("默认", format!("outfit:{id}:0"), pet.outfit_index == 0)];
    if let Some(pack_id) = effective.as_deref() {
        for (i, name) in petpack::pack_outfit_names(app, pack_id).into_iter().enumerate() {
            let idx = (i + 1) as u32;
            outfits.push(entry(name, format!("outfit:{id}:{idx}"), pet.outfit_index == idx));
        }
    }
    // 只留常切换的桌面行为模式；音效/气泡/抛掷/视角属于低频偏好，去设置页调
    let toggles = vec![
        entry("锁定位置", format!("toggle:{id}:lock"), pet.lock_position),
        entry("自动走动", format!("toggle:{id}:roam"), pet.roam_enabled),
        entry("跟随鼠标", format!("toggle:{id}:follow"), pet.follow_enabled),
        entry("任务栏模式", format!("toggle:{id}:ground"), pet.ground_enabled),
    ];

    let actions = vec![
        entry("重置位置", format!("reset:{id}"), false),
        entry("隐藏这只", format!("hide:{id}"), false),
        entry("复制这只桌宠", format!("dup:{id}"), false),
        entry("显示全部", "show_all", false),
    ];

    let footer = vec![
        entry("更多设置…", format!("settings:{id}"), false),
        MenuEntry {
            label: "退出".into(),
            action: "quit".into(),
            checked: false,
            danger: true,
        },
    ];

    PetMenuData {
        name: pet
            .display_name
            .clone()
            .or(pack_name)
            .unwrap_or_else(|| format!("桌宠 {id}")),
        scale: pct,
        scales,
        outfits,
        toggles,
        actions,
        footer,
    }
}

/// 菜单窗口待展示数据（show_pet_menu 存入；webview 未就绪时由 take_pet_menu 兜底取走）
#[derive(Default)]
struct PendingPetMenu(Mutex<Option<PetMenuData>>);

/// 菜单窗口逻辑尺寸（内容不足时下部透明；超出内部滚动）
const MENU_W: f64 = 256.0;
const MENU_H: f64 = 448.0;

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "show_all" => show_all_pets(app),
        "hide_all" => hide_all_pets(app),
        "settings" => {
            if let Err(e) = open_settings(app, None) {
                eprintln!("打开设置窗口失败: {e}");
            }
        }
        "quit" => app.exit(0),
        _ => {
            if let Some(pet) = id.strip_prefix("settings:") {
                if let Err(e) = open_settings(app, Some(pet.to_string())) {
                    eprintln!("打开设置窗口失败: {e}");
                }
            } else if let Some(rest) = id.strip_prefix("scale:") {
                let mut it = rest.splitn(2, ':');
                if let (Some(pet), Some(pct)) =
                    (it.next(), it.next().and_then(|v| v.parse::<f64>().ok()))
                {
                    let _ = update_pet(
                        app.clone(),
                        pet.to_string(),
                        PetPatch {
                            scale: Some(pct / 100.0),
                            ..Default::default()
                        },
                    );
                }
            } else if let Some(rest) = id.strip_prefix("outfit:") {
                let mut it = rest.splitn(2, ':');
                if let (Some(pet), Some(idx)) =
                    (it.next(), it.next().and_then(|v| v.parse::<u32>().ok()))
                {
                    eprintln!("[menu] outfit {pet} -> {idx}");
                    let _ = update_pet(
                        app.clone(),
                        pet.to_string(),
                        PetPatch {
                            outfit_index: Some(idx),
                            ..Default::default()
                        },
                    );
                }
            } else if let Some(rest) = id.strip_prefix("skin:") {
                let mut it = rest.splitn(2, ':');
                if let (Some(pet), Some(pack)) = (it.next(), it.next()) {
                    let _ = update_pet(
                        app.clone(),
                        pet.to_string(),
                        PetPatch {
                            petpack: Some(pack.to_string()),
                            ..Default::default()
                        },
                    );
                }
            } else if let Some(rest) = id.strip_prefix("toggle:") {
                let mut it = rest.splitn(2, ':');
                if let (Some(pet_id), Some(field)) = (it.next(), it.next()) {
                    let s = petpack::load_settings(app);
                    if let Some(pet) = s.pets.iter().find(|p| p.id == pet_id) {
                        let patch = match field {
                            "lock" => PetPatch {
                                lock_position: Some(!pet.lock_position),
                                ..Default::default()
                            },
                            "roam" => PetPatch {
                                roam_enabled: Some(!pet.roam_enabled),
                                ..Default::default()
                            },
                            "sound" => PetPatch {
                                sound_enabled: Some(!pet.sound_enabled),
                                ..Default::default()
                            },
                            "bubble" => PetPatch {
                                bubble_enabled: Some(!pet.bubble_enabled),
                                ..Default::default()
                            },
                            "fling" => PetPatch {
                                fling_enabled: Some(!pet.fling_enabled),
                                ..Default::default()
                            },
                            "gaze" => PetPatch {
                                gaze_enabled: Some(!pet.gaze_enabled),
                                ..Default::default()
                            },
                            "follow" => PetPatch {
                                follow_enabled: Some(!pet.follow_enabled),
                                ..Default::default()
                            },
                            "ground" => PetPatch {
                                ground_enabled: Some(!pet.ground_enabled),
                                ..Default::default()
                            },
                            _ => return,
                        };
                        let _ = update_pet(app.clone(), pet_id.to_string(), patch);
                    }
                }
            } else if let Some(pet) = id.strip_prefix("reset:") {
                let app2 = app.clone();
                let pet = pet.to_string();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = reset_pet_position(app2, pet) {
                        eprintln!("重置位置失败: {e}");
                    }
                });
            } else if let Some(src) = id.strip_prefix("dup:") {
                if let Err(e) = duplicate_pet_record(app, src) {
                    eprintln!("复制桌宠失败: {e}");
                }
            } else if let Some(label) = id.strip_prefix("hide:") {
                let _ = app.emit_to(label, "pet-hidden", label.to_string());
            }
        }
    }
}

/// 右键菜单在主线程执行，可以直接创建复制出来的桌宠窗口。
fn duplicate_pet_record(app: &AppHandle, id: &str) -> Result<Pet, String> {
    let src = petpack::load_settings(app)
        .pets
        .into_iter()
        .find(|p| p.id == id)
        .ok_or("桌宠不存在")?;
    let pet = add_pet_record(app, None, Some(&src))?;
    let on_top = petpack::load_settings(app).always_on_top;
    // 派发建窗：事件循环上下文里内联执行（与直接建窗等价），
    // 从 async 命令（菜单动作）调用时正确排队，两种上下文都安全
    create_pet_window_later(app, pet.clone(), on_top);
    Ok(pet)
}

// ---------- 气泡窗口 ----------

/// 无边框窗口（桌宠/气泡）在跨显示器 DPI 变化、频繁移动/改尺寸时偶发
/// 标题栏/边框回归（Windows WM_NCCALCSIZE 竞态）。周期性自检，发现装饰
/// 回归立即重新去掉。返回 true 表示本次修复了装饰回归。
#[tauri::command]
async fn ensure_undecorated(window: WebviewWindow) -> Result<bool, String> {
    match window.is_decorated() {
        Ok(true) => window.set_decorations(false).map_err(|e| e.to_string())?,
        Ok(false) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    }
    Ok(true)
}

/// 显示气泡窗口（启动时已创建、隐藏），定位到请求的桌宠上方。
/// 必须是 async：窗口操作走主线程事件循环，同步命令在 Windows 上会死锁。
#[tauri::command]
async fn show_bubble(app: AppHandle, x: i32, y: i32, owner: String) -> Result<(), String> {
    let state = app.state::<BubbleOwner>();
    if let Ok(mut g) = state.0.lock() {
        *g = Some(owner);
    }
    let Some(bubble) = app.get_webview_window("bubble") else {
        return Err("气泡窗口未初始化".into());
    };
    // 气泡随桌宠跨屏定位，同样可能装饰回归：显示前顺手自愈
    if matches!(bubble.is_decorated(), Ok(true)) {
        let _ = bubble.set_decorations(false);
    }
    bubble
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let _ = bubble.show();
    let _ = bubble.set_always_on_top(true);
    Ok(())
}

#[tauri::command]
async fn hide_bubble(app: AppHandle, owner: Option<String>) -> Result<(), String> {
    let state = app.state::<BubbleOwner>();
    if let Some(owner) = &owner
        && let Ok(g) = state.0.lock()
        && let Some(current) = g.as_ref()
        && current != owner
    {
        return Ok(()); // 已被其他桌宠接管
    }
    if let Some(b) = app.get_webview_window("bubble") {
        let _ = b.hide();
    }
    if let Ok(mut g) = state.0.lock() {
        *g = None;
    }
    Ok(())
}

// ---------- 设置窗口 ----------

/// 打开（或聚焦）设置窗口；可指定聚焦某只桌宠
fn open_settings(app: &tauri::AppHandle, focus: Option<String>) -> tauri::Result<()> {
    let state = app.state::<SettingsFocus>();
    if let Ok(mut g) = state.0.lock() {
        *g = focus.clone();
    }
    if let Some(w) = app.get_webview_window("settings") {
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(id) = focus {
            let _ = app.emit_to("settings", "focus-pet", id);
            if let Ok(mut g) = state.0.lock() {
                *g = None;
            }
        }
        return Ok(());
    }
    // 建窗必须发生在事件循环线程；调用方可能是菜单动作（async 命令 =
    // 运行时线程），统一派发。事件循环上下文里 run_on_main_thread 内联
    // 执行，与原先直接建窗等价。
    let app2 = app.clone();
    app.run_on_main_thread(move || {
        if let Err(e) = WebviewWindowBuilder::new(&app2, "settings", WebviewUrl::default())
            .title("设置")
            // 双栏布局（左栏桌宠列表 224px + 右栏内容）需要比旧 480px 更宽的默认窗宽
            .inner_size(760.0, 640.0)
            .min_inner_size(560.0, 500.0)
            .resizable(true)
            // 无边框 + 自绘标题栏；resizable 时运行时自动挂无边框缩放边缘处理器
            .decorations(false)
            .shadow(true)
            .build()
        {
            eprintln!("创建设置窗口失败: {e}");
        }
    })?;
    Ok(())
}

/// 在光标处显示桌宠右键菜单（HTML 菜单窗口渲染）。
/// 必须是 async：窗口定位/显示走主线程，同步命令在 Windows 上会死锁。
#[tauri::command]
async fn show_pet_menu(app: AppHandle, id: String, x: i32, y: i32) -> Result<(), String> {
    let data = build_pet_menu_data(&app, &id);
    if let Some(state) = app.try_state::<PendingPetMenu>()
        && let Ok(mut g) = state.0.lock()
    {
        *g = Some(data.clone());
    }
    app.emit_to("ctxmenu", "pet-menu-data", &data).map_err(|e| e.to_string())?;
    let win = app.get_webview_window("ctxmenu").ok_or("菜单窗口未初始化")?;
    // 默认锚在光标右下，按菜单尺寸 + 所在显示器工作区翻转收拢，防出屏
    let sf = win.scale_factor().map_err(|e| e.to_string())?;
    let (w, h, gap) = ((MENU_W * sf) as i32, (MENU_H * sf) as i32, (10.0 * sf) as i32);
    let (mut px, mut py) = (x + gap, y + gap);
    if let Ok(Some(m)) = win.current_monitor() {
        let area = m.work_area();
        let (ax, ay) = (area.position.x, area.position.y);
        let (aw, ah) = (area.size.width as i32, area.size.height as i32);
        if px + w > ax + aw {
            px = x - w - gap;
        }
        if py + h > ay + ah {
            py = y - h - gap;
        }
        px = px.max(ax);
        py = py.max(ay);
    }
    win.set_position(PhysicalPosition::new(px, py)).map_err(|e| e.to_string())?;
    win.show().map_err(|e| e.to_string())?;
    // 聚焦菜单窗口：失焦（点击菜单外）即收起，右键菜单的通行约定
    win.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn hide_pet_menu(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("ctxmenu") {
        let _ = w.hide();
    }
    Ok(())
}

/// 菜单 webview 挂载后拉取待展示数据（事件早于监听就绪的竞态兜底）
#[tauri::command]
fn take_pet_menu(app: AppHandle) -> Option<PetMenuData> {
    let state = app.state::<PendingPetMenu>();
    state.0.lock().ok().and_then(|mut g| g.take())
}

/// 执行菜单动作串：与原生菜单共用 handle_menu 的解析。
/// 必须是 async：dup/settings 分支可能建窗（见 create_pet_window_later 说明）。
#[tauri::command]
async fn run_pet_menu_action(app: AppHandle, action: String) -> Result<(), String> {
    handle_menu(&app, &action);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(SettingsFocus::default())
        .manage(BubbleOwner::default())
        .manage(PendingPetMenu::default())
        .invoke_handler(tauri::generate_handler![
            hit_context,
            ensure_undecorated,
            show_bubble,
            hide_bubble,
            show_pet_menu,
            hide_pet_menu,
            take_pet_menu,
            run_pet_menu_action,
            get_settings,
            pet_visibility,
            add_pet,
            duplicate_pet,
            remove_pet,
            update_pet,
            get_pet_outfit,
            update_global_prefs,
            save_pet_state,
            reset_pet_position,
            take_settings_focus,
            petpack::list_user_petpacks,
            petpack::import_petpack,
            petpack::import_model_folder,
            petpack::create_sprite_pack,
            petpack::write_pack_manifest,
            petpack::add_pack_sound,
            petpack::read_file_base64,
            petpack::export_petpack,
            petpack::delete_petpack,
            petpack::pack_cover_path,
            petpack::write_pack_cover,
            petpack::rename_petpack
        ])
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
        .setup(|app| {
            // 恢复全部桌宠（首次启动/旧版升级时补一只）。
            // 建窗逐个派发到主线程事件循环：setup 立即返回、托盘先就绪，
            // 多宠启动不被串行建窗卡住（WebView2 建窗仍须主线程，无法真并行）
            let settings = petpack::init_settings(app.handle());
            let handle = app.handle().clone();
            for pet in &settings.pets {
                create_pet_window_later(&handle, pet.clone(), settings.always_on_top);
            }

            // 气泡窗口：启动时在主线程一次性创建（隐藏、穿透），
            // 避免运行时在命令里创建窗口导致 Windows 死锁
            let _ = WebviewWindowBuilder::new(app, "bubble", WebviewUrl::default())
                .title("bubble")
                .inner_size(320.0, 120.0)
                .transparent(true)
                .decorations(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .shadow(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .build();
            if let Some(b) = app.get_webview_window("bubble") {
                let _ = b.set_ignore_cursor_events(true);
            }

            // 右键菜单窗口：启动时创建（隐藏），右键桌宠时定位显示。
            // 可聚焦（失焦即收起），不设穿透（要接鼠标点击）。
            let _ = WebviewWindowBuilder::new(app, "ctxmenu", WebviewUrl::default())
                .title("ctxmenu")
                .inner_size(MENU_W, MENU_H)
                .transparent(true)
                .decorations(false)
                .resizable(false)
                .visible(false)
                .focused(false)
                .shadow(false)
                .skip_taskbar(true)
                .always_on_top(true)
                .build();

            let menu = tray_menu(app.handle()).map_err(|e| e.to_string())?;
            TrayIconBuilder::with_id("pet-tray")
                .icon(app.default_window_icon().expect("missing icon").clone())
                .tooltip("Pet 桌宠")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .build(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}