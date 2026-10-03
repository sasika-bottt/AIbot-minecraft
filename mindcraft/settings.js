const settings = {
    "minecraft_version": "1.20.1", // or specific version like "1.21.6"
    // Set true ONLY when connecting to a Forge server (e.g. Forge-integrated LAN world).
    // Vanilla LAN servers MUST keep this false — Forge handshake on a vanilla server breaks login.
    // NOTE: Forge 1.12.2 has a known unfixed bug ("Can't serialize unregistered packet") that
    // kills the FML handshake over real TCP. Use a vanilla client instance to open the world for the bot.
    "forge_server": true, // 连接 Forge 整合包服务器时开启（走 FML3 握手）；原版服务器保持 false
    // Server's mod list, used with forge_server: true (must match the server exactly)
    "forge_mods": [],
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    "port": 25565, // Forge 服务端固定端口（原版 LAN 自动扫描时改回 -1）
    "auth": "offline", // or "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8080,
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "survival", // survival, assistant, creative, or god_mode（2026-10-02 主人令：改生存模式）
    "profiles": [
        "./wb.json",
    ],

    "load_memory": false, // load memory from previous session
    "init_message": "你好，请打个招呼并报上你的名字", // sends to all on spawn
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "en", // set to en to bypass google translate (bot already speaks Chinese via LLM persona)
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk（为批量建造开启，2026-10-01）
    "allow_vision": false, // allows vision model to interpret screenshots as inputs
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel", "!attackPlayer", "!goToRememberedPlace", "!rememberHere", "!viewChest", "!clearFurnace"] , // !goal 已在 actions.js 中硬禁用（unblockable，blocked_actions 无效）；!newAction 已解封用于批量建造
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 6, // max number of messages to keep in context
    "num_examples": 1, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
