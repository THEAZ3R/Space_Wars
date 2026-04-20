// ============================================================================
// ADD THIS TO YOUR index.html <style> SECTION:
// @keyframes bossWarn {
//     0%, 100% { opacity: 1; }
//     50% { opacity: 0.2; }
// }
// ============================================================================

// Sound Manager
const SoundManager = {
    sounds: {},
    music: null,
    muted: false,
    initialized: false,

    init() {
        if (this.initialized) return;
        this.initialized = true;
        this.load('shoot', 'sounds/shoot.mp3');
        this.load('dash', 'sounds/dash.mp3');
        this.load('laser', 'sounds/laser.mp3');
        this.load('powerup', 'sounds/powerup.mp3');
        this.load('nuke', 'sounds/nuke.mp3');
        this.load('explosion', 'sounds/explosion.mp3');
    },

    load(name, path) {
        const audio = new Audio(path);
        audio.preload = 'auto';
        this.sounds[name] = audio;
    },

    play(name, volume = 1.0) {
        if (this.muted) return;
        const sound = this.sounds[name];
        if (!sound) return;
        try {
            const clone = sound.cloneNode();
            clone.volume = volume;
            clone.play().catch(() => {});
        } catch (e) {
            sound.currentTime = 0;
            sound.volume = volume;
            sound.play().catch(() => {});
        }
    },

    playMusic(path, volume = 0.35) {
        if (this.muted) return;
        this.stopMusic();
        this.music = new Audio(path);
        this.music.loop = true;
        this.music.volume = volume;
        const playPromise = this.music.play();
        if (playPromise) playPromise.catch(() => {});
    },

    stopMusic() {
        if (this.music) {
            this.music.pause();
            this.music.currentTime = 0;
            this.music = null;
        }
    }
};

// High Score Manager
const HighScoreManager = {
    STORAGE_KEY: 'cosmic_bullet_hell_scores',

    getScores() {
        try {
            const data = localStorage.getItem(this.STORAGE_KEY);
            return data ? JSON.parse(data) : [];
        } catch (e) {
            return [];
        }
    },

    saveScore(name, score, wave, won) {
        const scores = this.getScores();
        const entry = {
            name: (name || 'Unknown').toUpperCase().substring(0, 12),
            score: score,
            wave: wave,
            won: won,
            date: new Date().toLocaleDateString()
        };
        scores.push(entry);
        scores.sort((a, b) => b.score - a.score);
        if (scores.length > 50) scores.length = 50;
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify(scores));
        return scores.findIndex(s => s === entry);
    },

    isHighScore(score) {
        const scores = this.getScores();
        if (scores.length < 10) return true;
        return score > (scores[9]?.score || 0);
    },

    getLeaderboard(limit = 10) {
        return this.getScores().slice(0, limit);
    },

    clear() {
        localStorage.removeItem(this.STORAGE_KEY);
    }
};

// ============================================================================
// MEMORY MANAGEMENT & RESOURCE POOLING
// ============================================================================

const ResourceManager = {
    geometries: new Map(),
    materials: new Map(),

    getBox(w, h, d) {
        const key = `box_${w.toFixed(3)}_${h.toFixed(3)}_${d.toFixed(3)}`;
        if (!this.geometries.has(key)) {
            this.geometries.set(key, new THREE.BoxGeometry(w, h, d));
        }
        return this.geometries.get(key);
    },

    getTorus(r, tube, radialSeg, tubularSeg) {
        const key = `torus_${r}_${tube}_${radialSeg}_${tubularSeg}`;
        if (!this.geometries.has(key)) {
            this.geometries.set(key, new THREE.TorusGeometry(r, tube, radialSeg, tubularSeg));
        }
        return this.geometries.get(key);
    },

    getCylinder(rt, rb, h, seg) {
        const key = `cyl_${rt}_${rb}_${h}_${seg}`;
        if (!this.geometries.has(key)) {
            this.geometries.set(key, new THREE.CylinderGeometry(rt, rb, h, seg));
        }
        return this.geometries.get(key);
    },

    getSphere(r, wSeg, hSeg) {
        const key = `sphere_${r}_${wSeg}_${hSeg}`;
        if (!this.geometries.has(key)) {
            this.geometries.set(key, new THREE.SphereGeometry(r, wSeg, hSeg));
        }
        return this.geometries.get(key);
    },

    disposeMesh(mesh) {
        if (!mesh) return;
        mesh.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach(m => m.dispose());
                } else {
                    child.material.dispose();
                }
            }
        });
    },

    clear() {
        this.geometries.forEach(g => g.dispose());
        this.geometries.clear();
        this.materials.forEach(m => m.dispose());
        this.materials.clear();
    }
};

// ============================================================================
// PARTICLE MATERIAL CACHE — reuse materials per color for explosion particles
// ============================================================================
const ParticleMaterialCache = {
    _cache: new Map(),

    get(color) {
        if (!this._cache.has(color)) {
            this._cache.set(color, new THREE.MeshBasicMaterial({ color }));
        }
        return this._cache.get(color);
    },

    clear() {
        this._cache.forEach(m => m.dispose());
        this._cache.clear();
    }
};

class ObjectPool {
    constructor(createFn, resetFn, initialSize = 20) {
        this.createFn = createFn;
        this.resetFn = resetFn;
        this.available = [];
        this.active = [];
        for (let i = 0; i < initialSize; i++) {
            const obj = createFn();
            obj._poolActive = false;
            this.available.push(obj);
        }
    }

    acquire() {
        let obj = this.available.pop();
        if (!obj) obj = this.createFn();
        obj._poolActive = true;
        this.active.push(obj);
        return obj;
    }

    release(obj) {
        const idx = this.active.indexOf(obj);
        if (idx >= 0) this.active.splice(idx, 1);
        this.resetFn(obj);
        obj._poolActive = false;
        this.available.push(obj);
    }

    releaseAll() {
        while (this.active.length > 0) this.release(this.active[0]);
    }

    getActive() { return this.active; }
}

// ============================================================================
// GAME FEEL SYSTEMS
// ============================================================================

const GameFeel = {
    shakeIntensity: 0,
    shakeDecay: 0.92,
    hitStopFrames: 0,
    cameraRecoil: { x: 0, y: 0 },

    shake(intensity) {
        this.shakeIntensity = Math.max(this.shakeIntensity, intensity);
    },

    hitStop(frames) {
        this.hitStopFrames = Math.max(this.hitStopFrames, frames);
    },

    recoil(x, y) {
        this.cameraRecoil.x += x;
        this.cameraRecoil.y += y;
    },

    update(camera, basePos) {
        if (this.hitStopFrames > 0) {
            this.hitStopFrames--;
            return false;
        }
        let sx = 0, sy = 0;
        if (this.shakeIntensity > 0.01) {
            sx = (Math.random() - 0.5) * this.shakeIntensity;
            sy = (Math.random() - 0.5) * this.shakeIntensity;
            this.shakeIntensity *= this.shakeDecay;
        } else {
            this.shakeIntensity = 0;
        }
        this.cameraRecoil.x *= 0.85;
        this.cameraRecoil.y *= 0.85;
        camera.position.set(
            basePos.x + sx + this.cameraRecoil.x,
            basePos.y + sy + this.cameraRecoil.y,
            basePos.z
        );
        return true;
    }
};

const EntityAnimator = {
    spawning: new Map(),
    dying: new Map(),
    flashing: new Map(),

    spawn(entity, duration = 400) {
        entity.mesh.scale.set(0.01, 0.01, 0.01);
        this.spawning.set(entity, { startTime: Date.now(), duration });
    },

    die(entity, duration = 300, onComplete) {
        this.dying.set(entity, { startTime: Date.now(), duration, onComplete });
    },

    flash(entity, duration = 80) {
        if (this.flashing.has(entity)) {
            this.flashing.get(entity).endTime = Date.now() + duration;
            return;
        }
        const originals = [];
        entity.mesh.traverse(child => {
            if (child.material) {
                originals.push({ child, mat: child.material });
                child.material = new THREE.MeshBasicMaterial({
                    color: 0xffffff,
                    transparent: child.material.transparent,
                    opacity: child.material.opacity
                });
            }
        });
        this.flashing.set(entity, { endTime: Date.now() + duration, originals });
    },

    update() {
        const now = Date.now();
        for (const [entity, data] of this.spawning) {
            const t = Math.min((now - data.startTime) / data.duration, 1);
            const scale = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
            entity.mesh.scale.set(scale, scale, scale);
            if (t >= 1) this.spawning.delete(entity);
        }
        for (const [entity, data] of this.dying) {
            const t = Math.min((now - data.startTime) / data.duration, 1);
            const scale = 1 - t;
            entity.mesh.scale.set(scale, scale, scale);
            entity.mesh.rotation.z += 0.3;
            if (t >= 1) {
                this.dying.delete(entity);
                if (data.onComplete) data.onComplete();
            }
        }
        for (const [entity, data] of this.flashing) {
            if (now > data.endTime) {
                data.originals.forEach(({ child, mat }) => { child.material = mat; });
                this.flashing.delete(entity);
            }
        }
    }
};

// ============================================================================
// GAME STATE
// ============================================================================

const game = {
    score: 0,
    wave: 1,
    maxWaves: 20,
    isPlaying: false,
    isPaused: false,
    player: null,
    enemies: [],
    bullets: [],
    enemyBullets: [],
    particles: [],
    powerups: [],
    stars: [],
    boss: null,
    waveInProgress: false,
    enemiesKilled: 0,
    totalEnemiesInWave: 0,
    totalEnemiesSpawned: 0,
    timeScale: 1,
    timeSlowEnd: 0,
    playerLasers: [],
    chainsaws: [],
    drones: [],
    enemyBeams: [],
    barrierMesh: null,
    nukeEffect: null,
    playerName: 'PILOT',
    godMode: false,
    difficulty: 'hard'
};

const playerStats = {
    maxHealth: 5,
    health: 5,
    speed: 0.15,
    attackSpeed: 1.2,
    laserLevel: 0,
    shotgunLevel: 0,
    chainsawLevel: 0,
    droneLevel: 0,
    barrier: false,
    invulnerable: false,
    invulnerableEnd: 0,
    autoLaserTimer: 0,
    magnetRadius: 0,
    dashLevel: 0,
    dashCooldown: 0,
    isDashing: false,
    nukeCount: 0
};

const bossEncounterOrder = ['mini3', 'mini1', 'mini2', 'boss4', 'boss5', 'boss6'];
function getBossForEncounter(encounterNum) {
    if (encounterNum <= 6) return bossEncounterOrder[encounterNum - 1];
    return bossEncounterOrder[(encounterNum - 1) % 6];
}

// ============================================================================
// INPUT
// ============================================================================

const keys = {};
const mouse = { x: 0, y: 0, down: false };

document.addEventListener('keydown', (e) => {
    keys[e.key.toLowerCase()] = true;
    if (e.key === 'p' || e.key === 'P') togglePause();
    if (e.key === 'c' || e.key === 'C') activateNuke();
    if (e.key === 'g' || e.key === 'G') toggleGodMode();
});
document.addEventListener('keyup', (e) => keys[e.key.toLowerCase()] = false);
document.addEventListener('mousemove', (e) => {
    mouse.x = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
});
document.addEventListener('mousedown', () => mouse.down = true);
document.addEventListener('mouseup', () => mouse.down = false);

// ============================================================================
// ENEMY TYPES CONFIG
// ============================================================================

const enemyTypes = {
    basic: { name: 'Drone', health: 1, speed: 0.02, score: 100, material: null, size: { w: 0.6, h: 0.6, d: 0.3 }, pattern: 'static', fireRate: 2000, damage: 1 },
    moving: { name: 'Striker', health: 2, speed: 0.05, score: 200, material: null, size: { w: 0.7, h: 0.7, d: 0.3 }, pattern: 'edges', fireRate: 1500, damage: 1 },
    fast: { name: 'Speeder', health: 1, speed: 0.08, score: 300, material: null, size: { w: 0.5, h: 0.5, d: 0.3 }, pattern: 'chase', fireRate: 800, damage: 1 },
    laser: { name: 'Laser', health: 3, speed: 0.01, score: 400, material: null, size: { w: 0.8, h: 0.4, d: 0.3 }, pattern: 'static', fireRate: 3000, damage: 2, laser: true },
    chaser: { name: 'Chaser', health: 2, speed: 0.06, score: 350, material: null, size: { w: 0.6, h: 0.6, d: 0.3 }, pattern: 'follow', fireRate: 1200, damage: 1 },
    tank: { name: 'Tank', health: 5, speed: 0.01, score: 500, material: null, size: { w: 1, h: 1, d: 0.4 }, pattern: 'static', fireRate: 2500, damage: 2 },
    splitter: { name: 'Splitter', health: 2, speed: 0.03, score: 450, material: null, size: { w: 0.7, h: 0.7, d: 0.3 }, pattern: 'bounce', fireRate: 1800, damage: 1, split: true },
    ghost: { name: 'Ghost', health: 2, speed: 0.04, score: 400, material: null, size: { w: 0.6, h: 0.6, d: 0.3 }, pattern: 'phase', fireRate: 1500, damage: 1, phase: true },
    bomber: { name: 'Bomber', health: 3, speed: 0.02, score: 600, material: null, size: { w: 0.8, h: 0.8, d: 0.3 }, pattern: 'drop', fireRate: 1000, damage: 2, bomb: true },
    saw: { name: 'Sawblade', health: 4, speed: 0.04, score: 500, material: null, size: { w: 0.9, h: 0.9, d: 0.3 }, pattern: 'rush', fireRate: 99999, damage: 2, chainsaw: true },
    suicide: { name: 'Kamikaze', health: 7, speed: 0.28, score: 250, material: null, size: { w: 0.6, h: 0.6, d: 0.3 }, pattern: 'suicide', fireRate: 0, damage: 2, suicide: true }
};

// ============================================================================
// BOSS TYPES CONFIG
// ============================================================================

const bossTypes = {
    mini1: { name: 'CRUSHER',            health:  50, material: null, pattern: 'sweep',           attacks: ['spread', 'laser', 'summon_minions', 'buzzsaw_swarm'],                            attackRate:  850 },
    mini2: { name: 'DESTROYER',          health:  75, material: null, pattern: 'bounce',          attacks: ['rapid', 'homing', 'laser_snipe', 'barrier_wall'],                              attackRate:  800 },
    mini3: { name: 'ANNIHILATOR',        health: 100, material: null, pattern: 'teleport',        attacks: ['spiral_aimed', 'spread', 'buzzsaw_swarm', 'summon_minions'],                   attackRate:  800, laserRate: 8000, laserDuration: 1500 },
    final: { name: 'COSMIC OVERLORD',    health: 200, material: null, pattern: 'all',             attacks: ['everything'],                                                                  attackRate:  600 },
    boss4: { name: 'VOID HERALD',        health: 130, material: null, pattern: 'figure8',         attacks: ['flower', 'vortex', 'ring', 'phase_trail', 'laser_snipe', 'buzzsaw_swarm'],     attackRate: 1000 },
    boss5: { name: 'NEBULA TYRANT',      health: 160, material: null, pattern: 'diag_bounce',     attacks: ['supernova', 'buzzsaw_rain', 'cross_laser', 'twin_spiral', 'summon_minions', 'barrier_wall'], attackRate: 1100 },
    boss6: { name: 'ECLIPSE SOVEREIGN',  health: 190, material: null, pattern: 'orbit',           attacks: ['pulse_wave', 'sniper_burst', 'cage', 'twin_spiral', 'spiral_aimed', 'laser_snipe', 'buzzsaw_swarm', 'summon_minions'], attackRate: 900 },
};

// ============================================================================
// ============================================================================
// DIFFICULTY CONFIG
// ============================================================================

const difficultySettings = {
    medium: {
        id: 'medium',
        name: 'CORSAIR',
        enemyHealthMult:    0.58,
        enemySpeedMult:     0.88,
        dropRate:           0.44,
        enemyDamageMult:    0.75,
        bossAttackRateMult: 1.40,
        bossHealthMult:     0.68,
        waveEnemyMult:      0.72,
        spawnDelay:         400,
        bannedAttacks:      ['summon_minions', 'buzzsaw_swarm', 'barrier_wall'],
    },
    hard: {
        id: 'hard',
        name: 'VANGUARD',
        enemyHealthMult:    1.0,
        enemySpeedMult:     1.0,
        dropRate:           0.25,
        enemyDamageMult:    1.0,
        bossAttackRateMult: 1.0,
        bossHealthMult:     1.0,
        waveEnemyMult:      1.0,
        spawnDelay:         350,
        bannedAttacks:      [],
    },
    hell: {
        id: 'hell',
        name: 'VOID REAPER',
        enemyHealthMult:    1.0,
        enemySpeedMult:     1.35,
        dropRate:           0.09,
        enemyDamageMult:    2.0,
        bossAttackRateMult: 0.60,
        bossHealthMult:     1.55,
        waveEnemyMult:      1.70,
        spawnDelay:         190,
        bannedAttacks:      [],
    }
};

function getDiffMod() {
    return difficultySettings[game.difficulty] || difficultySettings.hard;
}

function setDifficulty(diff) {
    game.difficulty = diff;
    ['medium', 'hard', 'hell'].forEach(d => {
        const btn = document.getElementById('diff-btn-' + d);
        if (btn) btn.classList.toggle('diff-active', d === diff);
    });
}

// POWERUP TYPES CONFIG
// ============================================================================

const powerupTypes = [
    { type: 'scoreSmall', chance: 0.25, material: null, value: 500 },
    { type: 'scoreMedium', chance: 0.2, material: null, value: 1000 },
    { type: 'scoreLarge', chance: 0.12, material: null, value: 2000 },
    { type: 'health', chance: 0.03, material: null },
    { type: 'attackSpeed', chance: 0.05, material: null },
    { type: 'laser', chance: 0.01, material: null },
    { type: 'shotgun', chance: 0.03, material: null },
    { type: 'timeSlow', chance: 0.025, material: null },
    { type: 'nuke', chance: 0.005, material: null },
    { type: 'chainsaw', chance: 0.04, material: null },
    { type: 'barrier', chance: 0.05, material: null },
    { type: 'magnet', chance: 0.015, material: null },
    { type: 'dash', chance: 0.008, material: null },
    { type: 'drone', chance: 0.008, material: null }
];

// ============================================================================
// THREE.JS SETUP & MATERIALS
// ============================================================================

let scene, camera, renderer, ambientLight, dirLight, materials;
let cameraBasePos;

try {
    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.02);

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    cameraBasePos = { x: 0, y: -8, z: 15 };
    camera.position.set(cameraBasePos.x, cameraBasePos.y, cameraBasePos.z);
    camera.lookAt(0, 5, 0);

    renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    // Position the canvas absolutely so AR canvas (z-index:90) can sit on top of it
    renderer.domElement.style.cssText = 'position:absolute;top:0;left:0;z-index:2;filter:contrast(1.18) saturate(1.45) brightness(1.08);';
    document.getElementById('gameContainer').appendChild(renderer.domElement);

    ambientLight = new THREE.AmbientLight(0x404040, 0.5);
    scene.add(ambientLight);

    dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(0, -10, 10);
    scene.add(dirLight);

    materials = {
        player: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
        playerGlow: new THREE.MeshBasicMaterial({ color: 0x00ff00, transparent: true, opacity: 0.3 }),
        enemyBasic: new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        enemyFast: new THREE.MeshBasicMaterial({ color: 0xff8800 }),
        enemyLaser: new THREE.MeshBasicMaterial({ color: 0xff00ff }),
        enemyMoving: new THREE.MeshBasicMaterial({ color: 0x00ffff }),
        enemyChaser: new THREE.MeshBasicMaterial({ color: 0xffff00 }),
        enemyTank: new THREE.MeshBasicMaterial({ color: 0x8844ff }),
        enemySplitter: new THREE.MeshBasicMaterial({ color: 0xff4488 }),
        enemyGhost: new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.7 }),
        enemyBomber: new THREE.MeshBasicMaterial({ color: 0xff4400 }),
        enemySaw: new THREE.MeshBasicMaterial({ color: 0xcc0000 }),
        enemySuicide: new THREE.MeshBasicMaterial({ color: 0xff6600 }),
        boss: new THREE.MeshBasicMaterial({ color: 0xaa0000 }),
        bulletPlayer: new THREE.MeshBasicMaterial({ color: 0x44ffaa, blending: THREE.AdditiveBlending, transparent: true }),
        bulletEnemy: new THREE.MeshBasicMaterial({ color: 0xff5500, blending: THREE.AdditiveBlending, transparent: true }),
        bulletLaser: new THREE.MeshBasicMaterial({ color: 0xff44ff, blending: THREE.AdditiveBlending, transparent: true }),
        bulletBomb: new THREE.MeshBasicMaterial({ color: 0xffbb00, blending: THREE.AdditiveBlending, transparent: true }),
        powerupHealth: new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        powerupAttack: new THREE.MeshBasicMaterial({ color: 0xffff00 }),
        powerupLaser: new THREE.MeshBasicMaterial({ color: 0x00ffff }),
        powerupShotgun: new THREE.MeshBasicMaterial({ color: 0xff00ff }),
        powerupTime: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
        powerupNuke: new THREE.MeshBasicMaterial({ color: 0xffffff }),
        powerupScore: new THREE.MeshBasicMaterial({ color: 0xffd700 }),
        powerupChainsaw: new THREE.MeshBasicMaterial({ color: 0x888888 }),
        powerupBarrier: new THREE.MeshBasicMaterial({ color: 0x00ffff }),
        powerupMagnet: new THREE.MeshBasicMaterial({ color: 0x0000ff }),
        powerupDash: new THREE.MeshBasicMaterial({ color: 0xffa500 }),
        powerupDrone: new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
        beam: new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending }),
        enemyBeam: new THREE.MeshBasicMaterial({ color: 0xff00ff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }),
        chainsaw: new THREE.MeshBasicMaterial({ color: 0xaaaaaa }),
        chainsawBlade: new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        barrier: new THREE.MeshBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.25, wireframe: true }),
        basicAccent:    new THREE.MeshBasicMaterial({ color: 0xff6666 }),
        movingDim:      new THREE.MeshBasicMaterial({ color: 0x007777 }),
        movingCore:     new THREE.MeshBasicMaterial({ color: 0x00ffff }),
        fastGlow:       new THREE.MeshBasicMaterial({ color: 0xffcc44 }),
        fastEngine:     new THREE.MeshBasicMaterial({ color: 0xffff00 }),
        laserCannon:    new THREE.MeshBasicMaterial({ color: 0xffaaff }),
        laserDark:      new THREE.MeshBasicMaterial({ color: 0x880088 }),
        chaserCore:     new THREE.MeshBasicMaterial({ color: 0xffff44 }),
        chaserLeg:      new THREE.MeshBasicMaterial({ color: 0xaaaa00 }),
        tankLight:      new THREE.MeshBasicMaterial({ color: 0xaa77ff }),
        tankDark:       new THREE.MeshBasicMaterial({ color: 0x441188 }),
        tankTop:        new THREE.MeshBasicMaterial({ color: 0xcc55ff }),
        splitterLink:   new THREE.MeshBasicMaterial({ color: 0xaa2255 }),
        splitterCore:   new THREE.MeshBasicMaterial({ color: 0xff88cc }),
        ghostInner:     new THREE.MeshBasicMaterial({ color: 0xcccccc, transparent: true, opacity: 0.5 }),
        bomberPod:      new THREE.MeshBasicMaterial({ color: 0xcc2200 }),
        bomberBay:      new THREE.MeshBasicMaterial({ color: 0x882200 }),
        bomberNozzle:   new THREE.MeshBasicMaterial({ color: 0xff8800 }),
        sawBlade:       new THREE.MeshBasicMaterial({ color: 0x888888 }),
        sawSpoke:       new THREE.MeshBasicMaterial({ color: 0xff0000 }),
        suicideGlow:    new THREE.MeshBasicMaterial({ color: 0xffaa00 }),
        suicideCore:    new THREE.MeshBasicMaterial({ color: 0xffffff }),
        suicideCenter:  new THREE.MeshBasicMaterial({ color: 0x000000 }),
        droneBody:      new THREE.MeshBasicMaterial({ color: 0x00ff00 }),
        droneFin:       new THREE.MeshBasicMaterial({ color: 0x00aa00 }),
        bulletHoming:   new THREE.MeshBasicMaterial({ color: 0xff2222, blending: THREE.AdditiveBlending, transparent: true }),
        bulletBomb:     new THREE.MeshBasicMaterial({ color: 0xff8800 }),
    };

    enemyTypes.basic.material = materials.enemyBasic;
    enemyTypes.moving.material = materials.enemyMoving;
    enemyTypes.fast.material = materials.enemyFast;
    enemyTypes.laser.material = materials.enemyLaser;
    enemyTypes.chaser.material = materials.enemyChaser;
    enemyTypes.tank.material = materials.enemyTank;
    enemyTypes.splitter.material = materials.enemySplitter;
    enemyTypes.ghost.material = materials.enemyGhost;
    enemyTypes.bomber.material = materials.enemyBomber;
    enemyTypes.saw.material = materials.enemySaw;
    enemyTypes.suicide.material = materials.enemySuicide;
    bossTypes.mini1.material = materials.boss;
    bossTypes.mini2.material = materials.boss;
    bossTypes.mini3.material = materials.boss;
    bossTypes.final.material = new THREE.MeshBasicMaterial({ color: 0x6600ff });
    bossTypes.boss4.material = new THREE.MeshBasicMaterial({ color: 0x8800ff });
    bossTypes.boss5.material = new THREE.MeshBasicMaterial({ color: 0xcc0044 });
    bossTypes.boss6.material = new THREE.MeshBasicMaterial({ color: 0x0088cc });
    powerupTypes[0].material = materials.powerupScore;
    powerupTypes[1].material = materials.powerupScore;
    powerupTypes[2].material = materials.powerupScore;
    powerupTypes[3].material = materials.powerupHealth;
    powerupTypes[4].material = materials.powerupAttack;
    powerupTypes[5].material = materials.powerupLaser;
    powerupTypes[6].material = materials.powerupShotgun;
    powerupTypes[7].material = materials.powerupTime;
    powerupTypes[8].material = materials.powerupNuke;
    powerupTypes[9].material = materials.powerupChainsaw;
    powerupTypes[10].material = materials.powerupBarrier;
    powerupTypes[11].material = materials.powerupMagnet;
    powerupTypes[12].material = materials.powerupDash;
    powerupTypes[13].material = materials.powerupDrone;

} catch (e) {
    console.error('Three.js initialization failed:', e);
    window.gameBootError = e.message;
}

function createBox(w, h, d, material, x, y, z) {
    const mesh = new THREE.Mesh(ResourceManager.getBox(w, h, d), material);
    mesh.position.set(x, y, z);
    return mesh;
}

// ============================================================================
// CREATE FUNCTIONS
// ============================================================================

function createStars() {
    const geometry = new THREE.BufferGeometry();
    const vertices = [];
    for (let i = 0; i < 1000; i++) {
        vertices.push((Math.random() - 0.5) * 100, (Math.random() - 0.5) * 100, (Math.random() - 0.5) * 50 - 10);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const material = new THREE.PointsMaterial({ color: 0xffffff, size: 0.1 });
    const stars = new THREE.Points(geometry, material);
    scene.add(stars);
    game.stars.push(stars);
}
if (scene) createStars();

function createPlayer() {
    const group = new THREE.Group();
    group.add(createBox(0.8, 0.8, 0.3, materials.player, 0, 0, 0));
    group.add(createBox(0.3, 0.5, 0.2, materials.player, -0.6, -0.2, 0));
    group.add(createBox(0.3, 0.5, 0.2, materials.player, 0.6, -0.2, 0));
    group.add(createBox(0.4, 0.2, 0.2, materials.playerGlow, 0, -0.6, 0));
    group.position.set(0, -6, 0);
    scene.add(group);
    return { mesh: group, x: 0, y: -6, width: 0.8, height: 0.8, lastShot: 0, vx: 0, vy: 0 };
}

function createEnemy(type, x, y) {
    const config = enemyTypes[type];
    const group = new THREE.Group();
    switch (type) {
        case 'basic': {
            const mat = materials.enemyBasic;
            group.add(createBox(0.6, 0.5, 0.3, mat, 0, 0, 0), createBox(0.15, 0.25, 0.2, mat, -0.35, 0.3, 0), createBox(0.15, 0.25, 0.2, mat, 0.35, 0.3, 0), createBox(0.2, 0.2, 0.2, mat, -0.5, -0.1, 0), createBox(0.2, 0.2, 0.2, mat, 0.5, -0.1, 0), createBox(0.2, 0.1, 0.25, materials.basicAccent, 0, 0, 0.2));
            break;
        }
        case 'moving': {
            const mat = materials.enemyMoving, dim = materials.movingDim;
            group.add(createBox(0.25, 0.7, 0.3, mat, 0, 0, 0), createBox(0.5, 0.15, 0.2, mat, -0.37, 0.1, 0), createBox(0.5, 0.15, 0.2, mat, 0.37, 0.1, 0), createBox(0.15, 0.2, 0.2, dim, -0.55, -0.15, 0), createBox(0.15, 0.2, 0.2, dim, 0.55, -0.15, 0), createBox(0.12, 0.12, 0.3, materials.movingCore, 0, 0.38, 0.1));
            break;
        }
        case 'fast': {
            const mat = materials.enemyFast, glow = materials.fastGlow;
            group.add(createBox(0.18, 0.75, 0.2, mat, 0, 0, 0), createBox(0.45, 0.12, 0.15, mat, 0, 0.1, 0), createBox(0.3, 0.1, 0.12, glow, 0, -0.25, 0), createBox(0.2, 0.08, 0.1, glow, 0, -0.38, 0), createBox(0.1, 0.1, 0.25, materials.fastEngine, 0, 0.38, 0));
            break;
        }
        case 'laser': {
            const mat = materials.enemyLaser, dark = materials.laserDark;
            group.add(createBox(0.9, 0.35, 0.3, mat, 0, 0, 0), createBox(0.15, 0.5, 0.25, mat, -0.3, -0.25, 0), createBox(0.15, 0.5, 0.25, mat, 0.3, -0.25, 0), createBox(0.35, 0.2, 0.35, dark, 0, 0.1, 0), createBox(0.12, 0.12, 0.4, materials.laserCannon, -0.3, -0.52, 0.1), createBox(0.12, 0.12, 0.4, materials.laserCannon, 0.3, -0.52, 0.1));
            break;
        }
        case 'chaser': {
            const mat = materials.enemyChaser, leg = materials.chaserLeg;
            group.add(createBox(0.45, 0.45, 0.35, mat, 0, 0, 0), createBox(0.12, 0.35, 0.15, leg, -0.35, 0.2, 0), createBox(0.12, 0.35, 0.15, leg, 0.35, 0.2, 0), createBox(0.12, 0.35, 0.15, leg, -0.35, -0.2, 0), createBox(0.12, 0.35, 0.15, leg, 0.35, -0.2, 0), createBox(0.18, 0.18, 0.45, materials.chaserCore, 0, 0, 0.1));
            break;
        }
        case 'tank': {
            const mat = materials.enemyTank, light = materials.tankLight, dark = materials.tankDark;
            group.add(createBox(1.0, 0.85, 0.45, mat, 0, 0, 0), createBox(0.65, 0.28, 0.5, light, 0, 0.4, 0), createBox(0.28, 0.28, 0.5, dark, -0.55, 0, 0), createBox(0.28, 0.28, 0.5, dark, 0.55, 0, 0), createBox(0.22, 0.55, 0.4, mat, 0, -0.35, 0), createBox(0.5, 0.15, 0.55, materials.tankTop, 0, 0.1, 0.15));
            break;
        }
        case 'splitter': {
            const mat = materials.enemySplitter, link = materials.splitterLink;
            group.add(createBox(0.38, 0.38, 0.3, mat, -0.28, 0.1, 0), createBox(0.38, 0.38, 0.3, mat, 0.28, 0.1, 0), createBox(0.2, 0.15, 0.2, link, 0, 0.1, 0), createBox(0.28, 0.28, 0.3, mat, 0, -0.25, 0), createBox(0.12, 0.12, 0.4, materials.splitterCore, -0.28, 0.1, 0.1), createBox(0.12, 0.12, 0.4, materials.splitterCore, 0.28, 0.1, 0.1));
            break;
        }
        case 'ghost': {
            const mat = materials.enemyGhost, inner = materials.ghostInner;
            group.add(createBox(0.5, 0.6, 0.2, mat, 0, 0.05, 0), createBox(0.18, 0.25, 0.15, mat, -0.32, -0.3, 0), createBox(0.18, 0.25, 0.15, mat, 0.32, -0.3, 0), createBox(0.12, 0.2, 0.15, mat, 0, -0.38, 0), createBox(0.22, 0.22, 0.3, inner, 0, 0.08, 0), createBox(0.35, 0.12, 0.12, mat, 0, 0.35, 0));
            break;
        }
        case 'bomber': {
            const mat = materials.enemyBomber, pod = materials.bomberPod, bay = materials.bomberBay;
            group.add(createBox(0.95, 0.4, 0.35, mat, 0, 0.1, 0), createBox(0.25, 0.55, 0.25, pod, -0.42, -0.15, 0), createBox(0.25, 0.55, 0.25, pod, 0.42, -0.15, 0), createBox(0.35, 0.2, 0.4, bay, 0, -0.1, 0), createBox(0.12, 0.22, 0.3, materials.bomberNozzle, -0.42, -0.48, 0), createBox(0.12, 0.22, 0.3, materials.bomberNozzle, 0.42, -0.48, 0));
            break;
        }
        case 'saw': {
            const mat = materials.enemySaw;
            group.add(createBox(0.6, 0.6, 0.3, mat, 0, 0, 0));
            const blade = new THREE.Mesh(ResourceManager.getTorus(0.4, 0.1, 6, 10), materials.sawBlade);
            blade.position.set(0, -0.5, 0);
            group.add(blade);
            for (let k = 0; k < 4; k++) {
                const spoke = createBox(0.08, 0.5, 0.05, materials.sawSpoke, 0, 0, 0);
                spoke.rotation.z = (Math.PI / 4) + (k * Math.PI / 2);
                spoke.position.set(0, -0.5, 0.05);
                group.add(spoke);
            }
            break;
        }
        case 'suicide': {
            const mat = materials.enemySuicide;
            group.add(createBox(0.6, 0.6, 0.3, mat, 0, 0, 0), createBox(0.4, 0.4, 0.4, materials.suicideGlow, 0, 0, 0.1), createBox(0.2, 0.2, 0.5, materials.suicideCore, 0, 0, 0.2), createBox(0.1, 0.1, 0.6, materials.suicideCenter, 0, 0, 0.3));
            break;
        }
        default: group.add(createBox(config.size.w, config.size.h, config.size.d, config.material, 0, 0, 0));
    }
    group.position.set(x, y, 0);
    scene.add(group);
    const waveMult = 1 + (game.wave * 0.1);
    const _dm = getDiffMod();
    const scaledHealth = Math.ceil(config.health * waveMult * _dm.enemyHealthMult);
    const scaledSpeed = config.speed * (1 + game.wave * 0.03) * _dm.enemySpeedMult;

    return { 
        mesh: group, type, x, y, vx: 0, vy: 0, 
        health: scaledHealth, maxHealth: scaledHealth, 
        speed: scaledSpeed,
        lastShot: Date.now() + Math.random() * 1000, 
        config, width: config.size.w, height: config.size.h, 
        phaseTimer: 0, direction: Math.random() > 0.5 ? 1 : -1, 
        chainsawRotation: 0 };
}

function createBoss(type) {
    const config = bossTypes[type];
    const group = new THREE.Group();

    if (type === 'boss4') {
        // VOID HERALD — angular, crystalline void-diamond
        const mat = config.material;
        const accent = new THREE.MeshBasicMaterial({ color: 0xff00ff });
        group.add(createBox(1.8, 1.8, 0.5, mat, 0, 0, 0));         // core diamond
        group.add(createBox(2.8, 0.25, 0.3, mat, 0, 0, 0));        // wide horizontal fin
        group.add(createBox(0.25, 2.8, 0.3, mat, 0, 0, 0));        // tall vertical spike
        group.add(createBox(0.5, 0.5, 0.7, accent, 0, 0, 0.2));    // glowing core
        group.add(createBox(0.15, 0.15, 0.5, accent, -1.0, 0, 0.1));
        group.add(createBox(0.15, 0.15, 0.5, accent,  1.0, 0, 0.1));
    } else if (type === 'boss5') {
        // NEBULA TYRANT — massive multi-winged dreadnought
        const mat = config.material;
        const core  = new THREE.MeshBasicMaterial({ color: 0xff0066 });
        const wing  = new THREE.MeshBasicMaterial({ color: 0x880033 });
        group.add(createBox(2.2, 2.2, 0.6, mat, 0, 0, 0));         // large hull
        group.add(createBox(0.7, 1.4, 0.35, wing, -2.0,  0.2, 0)); // left wing
        group.add(createBox(0.7, 1.4, 0.35, wing,  2.0,  0.2, 0)); // right wing
        group.add(createBox(1.0, 0.3,  0.3, wing, -2.0,  0.9, 0)); // left tip
        group.add(createBox(1.0, 0.3,  0.3, wing,  2.0,  0.9, 0)); // right tip
        group.add(createBox(0.9, 0.9,  0.8, core,  0, 0, 0.25));   // pulsing core
    } else if (type === 'boss6') {
        // ECLIPSE SOVEREIGN — crystalline ring-cross
        const mat = config.material;
        const ring  = new THREE.MeshBasicMaterial({ color: 0x00ffff });
        const inner = new THREE.MeshBasicMaterial({ color: 0x004466 });
        group.add(createBox(2.4, 0.45, 0.5, mat, 0, 0, 0));        // horizontal bar
        group.add(createBox(0.45, 2.4, 0.5, mat, 0, 0, 0));        // vertical bar
        group.add(createBox(1.5, 0.25, 0.35, inner, 0,  0.9, 0));  // upper cross
        group.add(createBox(1.5, 0.25, 0.35, inner, 0, -0.9, 0));  // lower cross
        group.add(createBox(0.8, 0.8,  0.8,  ring,  0,  0, 0.25)); // glowing orb
    } else {
        // Default boss mesh (mini1, mini2, mini3, final)
        group.add(createBox(2, 2, 0.5, config.material, 0, 0, 0));
        group.add(createBox(0.5, 1, 0.3, config.material, -1.5, 0, 0), createBox(0.5, 1, 0.3, config.material, 1.5, 0, 0));
        group.add(createBox(0.8, 0.8, 0.6, new THREE.MeshBasicMaterial({ color: 0xff0000 }), 0, 0, 0.2));
    }

    group.position.set(0, 6, 0);
    scene.add(group);
    const waveMult = 1 + (game.wave * 0.15);
    const _bDm = getDiffMod();
    const scaledHealth = Math.floor(config.health * waveMult * _bDm.bossHealthMult);
    return { 
        mesh: group, type, x: 0, y: 6, 
        health: scaledHealth, maxHealth: scaledHealth, 
        config, lastAttack: 0, attackPhase: 0, 
        width: 2.5, height: 2,
        lastTeleport: Date.now(),
        lastLaserAttack: 0,
        hasShieldActivated: false,
        shieldHealth: 0,
        shieldMax: 0,
        shieldMesh: null,
        // for diag_bounce pattern
        vbx: 0.06, vby: 0.03,
        // for orbit pattern
        orbitAngle: 0,
    };
}

function createBullet(x, y, vx, vy, isPlayer, isLaser = false, isHoming = false) {
    let size;
    if (isPlayer) size = { w: 0.12, h: 0.35, d: 0.12 };
    else if (isLaser) size = { w: 0.28, h: 1.1, d: 0.2 };
    else if (isHoming) size = { w: 0.36, h: 0.36, d: 0.36 };
    else size = { w: 0.28, h: 0.42, d: 0.2 };
    const material = isPlayer
        ? (isLaser ? materials.bulletLaser : materials.bulletPlayer)
        : (isHoming ? materials.bulletHoming : materials.bulletEnemy);
    const mesh = createBox(size.w, size.h, size.d, material, x, y, 0);
    scene.add(mesh);
    return { mesh, x, y, vx, vy, isPlayer, isLaser, isHoming, damage: isPlayer ? 1 : (isLaser ? 2 : 1), life: 3000 };
}

function createEnemyBeam(x, y, life = 2500) {
    const length = 30;
    const mesh = createBox(0.4, length, 0.2, materials.enemyBeam, x, y - length / 2 + 1, 0);
    scene.add(mesh);
    return { mesh, x, y: y - length / 2, width: 0.4, height: length, life, created: Date.now(), damageTimer: 0 };
}

function createHorizontalBeam(y, direction) {
    const length = 26;
    const width = 0.5;
    const startX = direction > 0 ? -16 : 16;
    const mesh = createBox(length, width, 0.25, materials.enemyBeam, startX, y, 0);
    scene.add(mesh);
    return { 
        mesh, x: startX, y, 
        vx: direction * 0.09, 
        width: length, height: width, 
        life: 6000, created: Date.now(), 
        damageTimer: 0,
        isHorizontal: true 
    };
}

function createExplosion(x, y, color, count = 8, intensity = 1) {
    const sharedMat = ParticleMaterialCache.get(color);
    for (let i = 0; i < count; i++) {
        const mesh = createBox(0.08 + Math.random() * 0.08, 0.08 + Math.random() * 0.08, 0.08, sharedMat, x, y, 0);
        scene.add(mesh);
        const angle = (Math.PI * 2 / count) * i + Math.random() * 0.5;
        const speed = (0.05 + Math.random() * 0.12) * intensity;
        const vx = Math.cos(angle) * speed;
        const vy = Math.sin(angle) * speed;
        game.particles.push({
            mesh, x, y, vx, vy,
            life: 400 + Math.random() * 600,
            maxLife: 1000,
            drag: 0.96,
            gravity: -0.002,
            rotSpeed: (Math.random() - 0.5) * 0.2
        });
    }
    if (intensity > 0.8) {
        const flash = createBox(0.5, 0.5, 0.1, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending }), x, y, 0.3);
        scene.add(flash);
        game.particles.push({
            mesh: flash, x, y, vx: 0, vy: 0,
            life: 200, maxLife: 200,
            drag: 1, gravity: 0, rotSpeed: 0,
            isFlash: true
        });
    }
}

function createPowerup(x, y, forcedType = null) {
    let selected;
    if (forcedType) {
        selected = powerupTypes.find(p => p.type === forcedType) || powerupTypes[0];
    } else {
        const rand = Math.random();
        let cumulative = 0;
        selected = powerupTypes[0];
        for (const p of powerupTypes) {
            cumulative += p.chance;
            if (rand <= cumulative) { selected = p; break; }
        }
    }
    const mesh = createBox(0.4, 0.4, 0.2, selected.material, x, y, 0);
    scene.add(mesh);
    const pu = { mesh, x, y, vy: -0.02, type: selected.type, config: selected, life: 10000, bobOffset: Math.random() * Math.PI * 2 };
    EntityAnimator.spawn(pu, 300);
    return pu;
}

// ============================================================================
// WAVE MANAGEMENT
// ============================================================================

function getWaveConfig(wave) {
    if (wave > game.maxWaves) return null;
    if (wave === game.maxWaves) return { boss: 'final' };
    const isBossWave = wave % 3 === 0;
    if (isBossWave) {
        const encounterNum = wave / 3;
        return { boss: getBossForEncounter(encounterNum) };
    }

    if (wave === 1) {
        return {
            enemies: 8,
            types: ['basic'],
            formation: 'grid',
            cols: 4, rows: 2,
            colSpacing: 2.8, rowSpacing: 1.6,
            startY: 7.5
        };
    }

    const enemyCount = Math.ceil((15 + wave * 4) * getDiffMod().waveEnemyMult);
    const types = ['basic'];
    if (wave >= 2) types.push('moving');
    if (wave >= 3) types.push('fast');
    if (wave >= 4) types.push('laser');
    if (wave >= 5) types.push('chaser');
    if (wave >= 6) types.push('tank');
    if (wave >= 7) types.push('splitter');
    if (wave >= 8) types.push('ghost');
    if (wave >= 9) types.push('bomber');
    if (wave >= 10) types.push('saw');
    if (wave >= 11) types.push('suicide');
    return { enemies: enemyCount, types };
}

function startWave() {
    if (game.wave > game.maxWaves) { gameWin(); return; }
    game.waveInProgress = true;
    const config = getWaveConfig(game.wave);
    const waveDisplay = document.getElementById('waveDisplay');
    if (config.boss) {
        waveDisplay.textContent = '⚠ WARNING ⚠';
        waveDisplay.style.color = '#f00';
        waveDisplay.style.textShadow = '0 0 30px #f00';
        waveDisplay.style.opacity = '1';
        waveDisplay.style.animation = 'bossWarn 0.25s ease-in-out 4';

        setTimeout(() => {
            waveDisplay.textContent = `BOSS: ${bossTypes[config.boss].name}`;
            waveDisplay.style.animation = '';
            waveDisplay.style.color = '#f00';
            waveDisplay.style.textShadow = '0 0 20px #f00';
            setTimeout(() => waveDisplay.style.opacity = '0', 2000);
        }, 1000);
    } else {
        waveDisplay.textContent = `WAVE ${game.wave}`;
        waveDisplay.style.color = '#0ff';
        waveDisplay.style.textShadow = '0 0 20px #0ff';
        waveDisplay.style.animation = '';
        waveDisplay.style.opacity = '1';
        setTimeout(() => waveDisplay.style.opacity = '0', 2000);
    }

    if (config.boss) {
        game.boss = createBoss(config.boss);
        EntityAnimator.spawn(game.boss, 800);
        document.getElementById('bossName').style.display = 'block';
        document.getElementById('bossName').textContent = bossTypes[config.boss].name;
        document.getElementById('bossHealth').style.display = 'block';
        updateBossHealth();
    } else {
        game.totalEnemiesInWave = config.enemies;
        game.enemiesKilled = 0;
        game.totalEnemiesSpawned = 0;

        if (config.formation === 'grid') {
            const { cols, rows, colSpacing, rowSpacing, startY, types } = config;
            const totalW = (cols - 1) * colSpacing;
            let spawnIndex = 0;
            for (let row = 0; row < rows; row++) {
                for (let col = 0; col < cols; col++) {
                    const x = -totalW / 2 + col * colSpacing;
                    const y = startY + row * rowSpacing;
                    const delay = spawnIndex * 500;
                    spawnIndex++;
                    setTimeout(() => {
                        if (!game.isPlaying || game.isPaused) return;
                        const type = types[Math.floor(Math.random() * types.length)];
                        const enemy = createEnemy(type, x, y);
                        EntityAnimator.spawn(enemy, 500);
                        game.enemies.push(enemy);
                        game.totalEnemiesSpawned++;
                    }, delay);
                }
            }
        } else {
            for (let i = 0; i < config.enemies; i++) {
                setTimeout(() => {
                    if (!game.isPlaying || game.isPaused) return;
                    // If a nuke snapped the counters, skip any remaining queued spawns
                    if (game.totalEnemiesSpawned >= game.totalEnemiesInWave) return;
                    const type = config.types[Math.floor(Math.random() * config.types.length)];
                    const x = (Math.random() - 0.5) * 12;
                    const y = 8 + Math.random() * 2;
                    const enemy = createEnemy(type, x, y);
                    EntityAnimator.spawn(enemy, 400);
                    game.enemies.push(enemy);
                    game.totalEnemiesSpawned++;
                }, i * getDiffMod().spawnDelay);
            }
        }
    }
    updateUI();
}

function updateBossHealth() {
    if (!game.boss) return;
    const b = game.boss;
    const bar = document.getElementById('bossHealthBar');
    const name = document.getElementById('bossName');
    
    if (b.hasShieldActivated && b.shieldHealth > 0) {
        const shieldPct = (b.shieldHealth / b.shieldMax) * 100;
        bar.style.width = shieldPct + '%';
        bar.style.background = 'linear-gradient(90deg, #00ffff, #0088ff)';
        name.textContent = bossTypes[b.type].name + ' ♦ SHIELD';
        name.style.color = '#00ffff';
        name.style.textShadow = '0 0 15px #00ffff';
    } else {
        const pct = (b.health / b.maxHealth) * 100;
        bar.style.width = pct + '%';
        bar.style.background = 'linear-gradient(90deg, #f00, #ff0)';
        name.textContent = bossTypes[b.type].name;
        name.style.color = '#f00';
        name.style.textShadow = '0 0 10px #f00';
    }
}

function waveComplete() {
    game.waveInProgress = false;
    game.wave++;
    game.enemyBullets.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.enemyBullets = [];
    game.enemyBeams.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.enemyBeams = [];
    setTimeout(() => startWave(), 2000);
}

// ============================================================================
// BARRIER
// ============================================================================

function updateBarrier() {
    if (playerStats.barrier && game.player) {
        if (!game.barrierMesh) {
            game.barrierMesh = new THREE.Mesh(ResourceManager.getSphere(1.0, 16, 16), materials.barrier);
            scene.add(game.barrierMesh);
        }
        game.barrierMesh.position.set(game.player.x, game.player.y, 0);
        game.barrierMesh.rotation.z += 0.02;
        game.barrierMesh.rotation.y += 0.02;
    } else if (game.barrierMesh) {
        scene.remove(game.barrierMesh);
        ResourceManager.disposeMesh(game.barrierMesh);
        game.barrierMesh = null;
    }
}

// ============================================================================
// PLAYER LASERS
// ============================================================================

function spawnPlayerLaser() {
    if (!game.player || playerStats.laserLevel <= 0) return;
    const beamLength = 25;
    const beamWidth = 0.4 + playerStats.laserLevel * 0.15;
    const mesh = createBox(beamWidth, beamLength, 0.12, materials.beam, game.player.x, game.player.y + beamLength / 2, 0);
    scene.add(mesh);
    game.playerLasers.push({
        mesh, x: game.player.x, y: game.player.y,
        width: beamWidth, height: beamLength,
        created: Date.now(),
        life: 500 + playerStats.laserLevel * 150,
        damageTimers: new Map()
    });
    SoundManager.play('laser', 0.4);
}

function updatePlayerLasers() {
    if (!game.player) return;
    const laserLevel = playerStats.laserLevel;
    if (laserLevel === 0) {
        for (let i = game.playerLasers.length - 1; i >= 0; i--) {
            scene.remove(game.playerLasers[i].mesh);
            ResourceManager.disposeMesh(game.playerLasers[i].mesh);
            game.playerLasers.splice(i, 1);
        }
        return;
    }
    const fireRate = Math.max(2000, 6000 - laserLevel * 1250);
    const now = Date.now();
    if (now - playerStats.autoLaserTimer > fireRate) {
        playerStats.autoLaserTimer = now;
        spawnPlayerLaser();
    }
    for (let i = game.playerLasers.length - 1; i >= 0; i--) {
        const beam = game.playerLasers[i];
        if (now - beam.created > beam.life) {
            scene.remove(beam.mesh);
            ResourceManager.disposeMesh(beam.mesh);
            game.playerLasers.splice(i, 1);
            continue;
        }
        for (let j = game.enemies.length - 1; j >= 0; j--) {
            const e = game.enemies[j];
            if (Math.abs(e.x - beam.x) < (e.width + beam.width) / 2 && e.y > game.player.y && e.y < game.player.y + beam.height) {
                const lastHit = beam.damageTimers.get(e) || 0;
                if (now - lastHit > 80) {
                    beam.damageTimers.set(e, now);
                    e.health -= 0.5;
                    EntityAnimator.flash(e, 60);
                    createExplosion(e.x, e.y, 0x00ffff, 2, 0.5);
                    if (e.health <= 0) {
                        killEnemy(e, j);
                        j--;
                    }
                }
            }
        }
        // DAMAGE BOSS WITH LASER
        if (game.boss && Math.abs(game.boss.x - beam.x) < (game.boss.width + beam.width) / 2 
            && game.boss.y > game.player.y && game.boss.y < game.player.y + beam.height) {
            const lastHit = beam.damageTimers.get(game.boss) || 0;
            if (now - lastHit > 80) {
                beam.damageTimers.set(game.boss, now);
                applyDamageToBoss(0.5, beam.x, game.boss.y);
            }
        }
    }
}

// ============================================================================
// CHAINSAWS
// ============================================================================

function updateChainsaws() {
    if (!game.player) return;
    const level = playerStats.chainsawLevel;
    while (game.chainsaws.length > level) {
        const c = game.chainsaws.pop();
        scene.remove(c.mesh);
        ResourceManager.disposeMesh(c.mesh);
    }
    while (game.chainsaws.length < level) {
        const group = new THREE.Group();
        const ring = new THREE.Mesh(ResourceManager.getTorus(0.5, 0.1, 6, 12), materials.chainsaw);
        group.add(ring);
        const blade = new THREE.Mesh(ResourceManager.getCylinder(0.45, 0.45, 0.08, 6), materials.chainsawBlade);
        blade.rotation.x = Math.PI / 2;
        group.add(blade);
        for (let j = 0; j < 8; j++) {
            const tooth = createBox(0.1, 0.2, 0.08, materials.chainsawBlade,
                Math.cos(j / 8 * Math.PI * 2) * 0.5,
                Math.sin(j / 8 * Math.PI * 2) * 0.5, 0);
            group.add(tooth);
        }
        scene.add(group);
        game.chainsaws.push({ mesh: group, angle: (Math.PI * 2 / (level || 1)) * game.chainsaws.length, damageTimers: new Map() });
    }
    if (level === 0) return;

    game.chainsaws.forEach((c, idx) => {
        const now = Date.now();
        const time = now / 1000;
        c.mesh.rotation.z -= 0.5 * game.timeScale;
        c.mesh.rotation.y += 0.2 * game.timeScale;
        c.mesh.rotation.x += 0.1 * game.timeScale;
        c.angle += (0.05 + idx * 0.01) * game.timeScale;
        const baseRadius = 5.5;
        const chaoticX = Math.sin(time * 2.3 + idx) * 1.5 + Math.cos(time * 1.7 + idx * 2) * 1.0;
        const chaoticY = Math.cos(time * 2.8 + idx) * 1.2 + Math.sin(time * 3.1 + idx * 1.5) * 0.8;
        const radiusVar = Math.sin(time * 4.0 + c.angle) * 1.5;
        const radius = baseRadius + radiusVar;
        c.mesh.position.set(
            game.player.x + Math.cos(c.angle) * radius + chaoticX,
            game.player.y + Math.sin(c.angle * 1.3) * radius * 0.6 + chaoticY,
            Math.sin(time * 5 + idx) * 0.5
        );
        for (let j = game.enemies.length - 1; j >= 0; j--) {
            const e = game.enemies[j];
            const dx = e.x - c.mesh.position.x;
            const dy = e.y - c.mesh.position.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 2.5) {
                const lastHit = c.damageTimers.get(e) || 0;
                if (now - lastHit > 60) {
                    c.damageTimers.set(e, now);
                    e.health -= 2;
                    EntityAnimator.flash(e, 40);
                    createExplosion(e.x + (Math.random()-0.5)*0.3, e.y + (Math.random()-0.5)*0.3, 0xff0000, 3, 0.6);
                    if (e.health <= 0) {
                        killEnemy(e, j);
                        j--;
                    }
                }
            }
        }
        // DAMAGE BOSS WITH CHAINSAWS
        if (game.boss) {
            const dx = game.boss.x - c.mesh.position.x;
            const dy = game.boss.y - c.mesh.position.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 2.5) {
                const lastHit = c.damageTimers.get(game.boss) || 0;
                if (now - lastHit > 60) {
                    c.damageTimers.set(game.boss, now);
                    applyDamageToBoss(2, c.mesh.position.x, c.mesh.position.y);
                }
            }
        }
    });
}

// ============================================================================
// DRONES
// ============================================================================

function createDrone(playerX, playerY, offsetAngle) {
    const group = new THREE.Group();
    group.add(createBox(0.3, 0.3, 0.2, materials.droneBody, 0, 0, 0));
    group.add(createBox(0.1, 0.2, 0.1, materials.droneFin, 0, 0.2, 0));
    scene.add(group);
    return { mesh: group, x: playerX, y: playerY, angle: offsetAngle, lastShot: 0 };
}

function updateDrones() {
    if (!game.player) return;
    const level = playerStats.droneLevel;
    const now = Date.now();
    while (game.drones.length > level) { const d = game.drones.pop(); scene.remove(d.mesh); ResourceManager.disposeMesh(d.mesh); }
    while (game.drones.length < level) { game.drones.push(createDrone(game.player.x, game.player.y, (Math.PI * 2 / (level || 1)) * game.drones.length)); }
    if (level === 0) return;
    game.drones.forEach((d) => {
        d.angle += 0.04 * game.timeScale;
        const radius = 1.8;
        d.x = game.player.x + Math.cos(d.angle) * radius;
        d.y = game.player.y + Math.sin(d.angle) * radius;
        d.mesh.position.set(d.x, d.y, 0);
        d.mesh.rotation.z += 0.1 * game.timeScale;
        if (now - d.lastShot > 600 / game.timeScale) {
            d.lastShot = now;
            game.bullets.push(createBullet(d.x, d.y + 0.2, 0, 0.25, true));
        }
    });
}

// ============================================================================
// ENEMY BEAMS
// ============================================================================

function updateEnemyBeams() {
    const now = Date.now();
    for (let i = game.enemyBeams.length - 1; i >= 0; i--) {
        const b = game.enemyBeams[i];
        
        if (b.isHorizontal) {
            b.x += b.vx * game.timeScale;
            b.mesh.position.x = b.x;
        }
        
        if (game.player && checkCollision(b, game.player) && !playerStats.invulnerable) {
            if (now - b.damageTimer > 400) {
                b.damageTimer = now;
                handlePlayerHit(Math.ceil(1 * getDiffMod().enemyDamageMult));
            }
        }
        
        let expired = false;
        if (b.isHorizontal) {
            if (Math.abs(b.x) > 18) expired = true;
        } else {
            if (now - b.created > b.life) expired = true;
        }
        
        if (expired) {
            scene.remove(b.mesh);
            ResourceManager.disposeMesh(b.mesh);
            game.enemyBeams.splice(i, 1);
        }
    }
}

// ============================================================================
// BOSS DAMAGE HELPER
// ============================================================================

function applyDamageToBoss(damage, x, y) {
    const b = game.boss;
    if (!b) return;

    if (b.hasShieldActivated && b.shieldHealth > 0) {
        b.shieldHealth -= damage;
        EntityAnimator.flash(b, 40);
        createExplosion(x, y, 0x00ffff, 4, 0.5);
        GameFeel.shake(0.2);
        updateBossHealth();

        if (b.shieldHealth <= 0) {
            showFloatingText('SHIELD BROKEN!', b.x, b.y + 2.5, 0x00ffff);
            if (b.shieldMesh) {
                scene.remove(b.shieldMesh);
                ResourceManager.disposeMesh(b.shieldMesh);
                b.shieldMesh = null;
            }
            createExplosion(b.x, b.y, 0x00ffff, 12, 1.2);
        }
    } else {
        b.health -= damage;
        updateBossHealth();
        EntityAnimator.flash(b, 60);
        createExplosion(x, y, 0xffaa00, 4, 0.6);
        GameFeel.shake(0.15);
        GameFeel.hitStop(2);

        if (b.health <= 0) {
            createExplosion(b.x, b.y, 0xff0000, 40, 2.0);
            SoundManager.play('explosion', 0.7);
            GameFeel.shake(2.5);
            GameFeel.hitStop(8);
            const bossScore = b.type === 'final' ? 100000 : 25000;
            game.score += bossScore;
            showFloatingText('+' + bossScore.toLocaleString(), b.x, b.y, 0xffd700);

            if (Math.random() < 0.3) {
                const ultraRareTypes = ['dash', 'drone', 'nuke'];
                game.powerups.push(createPowerup(b.x, b.y, ultraRareTypes[Math.floor(Math.random() * ultraRareTypes.length)]));
            }
            game.powerups.push(createPowerup(b.x - 0.6, b.y));
            game.powerups.push(createPowerup(b.x + 0.6, b.y));

            if (b.shieldMesh) {
                scene.remove(b.shieldMesh);
                ResourceManager.disposeMesh(b.shieldMesh);
            }
            scene.remove(b.mesh);
            ResourceManager.disposeMesh(b.mesh);
            game.boss = null;
            document.getElementById('bossName').style.display = 'none';
            document.getElementById('bossHealth').style.display = 'none';
            waveComplete();
        }
    }
}

// ============================================================================
// PLAYER HIT & ENEMY DEATH
// ============================================================================

function handlePlayerHit(damage) {
    if (playerStats.isDashing) return;
    if (game.godMode) {
        if (game.player) createExplosion(game.player.x, game.player.y, 0xffd700, 4, 0.4);
        return;
    }
    if (playerStats.barrier) {
        playerStats.barrier = false;
        scene.remove(game.barrierMesh);
        ResourceManager.disposeMesh(game.barrierMesh);
        game.barrierMesh = null;
        playerStats.invulnerable = true;
        playerStats.invulnerableEnd = Date.now() + 600;
        createExplosion(game.player.x, game.player.y, 0x00ffff, 12, 1.2);
        GameFeel.shake(0.8);
        showFloatingText('BARRIER BROKEN', game.player.x, game.player.y, 0x00ffff);
    } else {
        playerStats.health -= damage;
        playerStats.invulnerable = true;
        playerStats.invulnerableEnd = Date.now() + 1500;
        createExplosion(game.player.x, game.player.y, 0x00ff00, 14, 1.5);
        GameFeel.shake(1.2);
        GameFeel.hitStop(3);
        GameFeel.recoil(0, -0.3);
        if (playerStats.health <= 0) {
            game.timeScale = 0.08;
            game.timeSlowEnd = Date.now() + 9999999;
            const deathZoomInterval = setInterval(() => {
                if (!camera) { clearInterval(deathZoomInterval); return; }
                cameraBasePos.z = Math.max(8, cameraBasePos.z - 0.25);
                camera.lookAt(
                    game.player ? game.player.x * 0.5 : 0,
                    game.player ? game.player.y : 0,
                    0
                );
            }, 16);
            showFloatingText('DESTROYED', game.player ? game.player.x : 0, game.player ? game.player.y : 0, 0xff0000);
            setTimeout(() => {
                clearInterval(deathZoomInterval);
                cameraBasePos.z = 15;
                game.timeScale = 1;
                game.timeSlowEnd = 0;
                gameOver();
            }, 2200);
        }
    }
    updateUI();
}

function killEnemy(e, index) {
    createExplosion(e.x, e.y, 0xff0000, 14, 1.2);
    GameFeel.shake(0.4);
    game.score += e.config.score;
    if (Math.random() < getDiffMod().dropRate) game.powerups.push(createPowerup(e.x, e.y));
    const enemy = game.enemies[index];
    game.enemies.splice(index, 1);
    EntityAnimator.die(enemy, 250, () => {
        scene.remove(enemy.mesh);
        ResourceManager.disposeMesh(enemy.mesh);
    });
    game.enemiesKilled++;
}

// ============================================================================
// PLAYER UPDATE
// ============================================================================

function updatePlayer() {
    if (!game.player) return;
    const p = game.player;
    const stats = playerStats;
    const now = Date.now();

    if (stats.dashLevel > 0 && keys['shift'] && now > stats.dashCooldown) {
        const baseCooldown = 3000;
        const reductionPerLevel = 325;
        const currentCooldown = Math.max(400, baseCooldown - (stats.dashLevel - 1) * reductionPerLevel);

        stats.isDashing = true;
        stats.invulnerable = true;
        stats.invulnerableEnd = now + 250;
        stats.dashCooldown = now + currentCooldown;
        createExplosion(p.x, p.y, 0xffa500, 8, 1.0);
        GameFeel.shake(0.5);
        showFloatingText('DASH!', p.x, p.y, 0xffa500);
        SoundManager.play('dash', 0.6);

        let dashDx = 0, dashDy = 0;
        if (keys['w'] || keys['arrowup']) dashDy = 1;
        if (keys['s'] || keys['arrowdown']) dashDy = -1;
        if (keys['a'] || keys['arrowleft']) dashDx = -1;
        if (keys['d'] || keys['arrowright']) dashDx = 1;
        if (dashDx === 0 && dashDy === 0) dashDy = 1;

        const dashSpeed = 4;
        p.x += dashDx * dashSpeed;
        p.y += dashDy * dashSpeed;
        p.x = Math.max(-8, Math.min(8, p.x));
        p.y = Math.max(-7, Math.min(-2, p.y));
        setTimeout(() => { stats.isDashing = false; }, 250);
    }

    let dx = 0, dy = 0;
    if (keys['w'] || keys['arrowup']) dy = 1;
    if (keys['s'] || keys['arrowdown']) dy = -1;
    if (keys['a'] || keys['arrowleft']) dx = -1;
    if (keys['d'] || keys['arrowright']) dx = 1;
    if (dx !== 0 && dy !== 0) { dx *= 0.707; dy *= 0.707; }

    if (!stats.isDashing) {
        const accel = 0.008;
        const maxSpeed = stats.speed * game.timeScale;
        p.vx += (dx * maxSpeed - p.vx) * accel * game.timeScale * 60;
        p.vy += (dy * maxSpeed - p.vy) * accel * game.timeScale * 60;
        p.x += p.vx;
        p.y += p.vy;
    }
    p.x = Math.max(-8, Math.min(8, p.x));
    p.y = Math.max(-7, Math.min(-2, p.y));
    p.mesh.position.set(p.x, p.y, 0);

    p.mesh.rotation.z = -p.vx * 2;
    p.mesh.rotation.x = p.vy * 1.5;

    if (stats.invulnerable && now > stats.invulnerableEnd) {
        stats.invulnerable = false;
        p.mesh.visible = true;
    }
    if (stats.invulnerable) p.mesh.visible = Math.floor(now / 80) % 2 === 0;

    const fireDelay = 250 / stats.attackSpeed;
    if ((keys[' '] || mouse.down) && now - p.lastShot > fireDelay) {
        p.lastShot = now;
        game.bullets.push(createBullet(p.x, p.y + 0.5, 0, 0.3, true));
        SoundManager.play('shoot', 0.3);
        if (stats.shotgunLevel > 0) {
            for (let i = 1; i <= stats.shotgunLevel; i++) {
                const angle = i * 0.3;
                game.bullets.push(createBullet(p.x, p.y + 0.5, -Math.sin(angle) * 0.3, Math.cos(angle) * 0.3, true));
                game.bullets.push(createBullet(p.x, p.y + 0.5, Math.sin(angle) * 0.3, Math.cos(angle) * 0.3, true));
            }
        }
    }
}

// ============================================================================
// ENEMIES UPDATE
// ============================================================================

function updateEnemies() {
    const now = Date.now();
    for (let i = game.enemies.length - 1; i >= 0; i--) {
        const e = game.enemies[i];
        const config = e.config;
        switch (config.pattern) {
            case 'static': e.y -= e.speed * game.timeScale * 0.08; break;
            case 'edges':
                if (e.x < -8) e.direction = 1;
                if (e.x > 8) e.direction = -1;
                e.x += e.direction * e.speed * game.timeScale;
                e.y -= e.speed * 0.06 * game.timeScale;
                break;
            case 'chase': e.x += Math.sign(game.player.x - e.x) * e.speed * game.timeScale; e.y -= e.speed * 0.12 * game.timeScale; break;
            case 'follow': {
                const fdx = game.player.x - e.x, fdy = game.player.y - e.y;
                const dist = Math.sqrt(fdx * fdx + fdy * fdy);
                if (dist > 0) { e.x += (fdx / dist) * e.speed * game.timeScale; e.y += (fdy / dist) * e.speed * game.timeScale * 0.18; }
                break;
            }
            case 'bounce':
                e.x += e.direction * e.speed * game.timeScale;
                if (Math.abs(e.x) > 8) e.direction *= -1;
                e.y -= e.speed * 0.07 * game.timeScale;
                break;
            case 'phase':
                e.phaseTimer += 16 * game.timeScale;
                e.mesh.children.forEach(child => { if (child.material && child.material.opacity !== undefined) child.material.opacity = 0.3 + Math.sin(e.phaseTimer / 200) * 0.4; });
                e.y -= e.speed * game.timeScale * 0.1;
                break;
            case 'drop':
                e.y -= e.speed * game.timeScale * 0.3;
                if (e.y < game.player.y + 2 && e.y > game.player.y - 2 && !e.hasDroppedBomb) {
                    e.hasDroppedBomb = true;
                    const bomb = createBullet(e.x, e.y - 0.5, 0, -0.12, false);
                    bomb.isBomb = true;
                    bomb.mesh.scale.set(1.8, 1.8, 1.8);
                    bomb.mesh.material = materials.bulletBomb;
                    game.enemyBullets.push(bomb);
                }
                break;
            case 'rush': {
                const rdx = game.player.x - e.x, rdy = game.player.y - e.y;
                const rdist = Math.sqrt(rdx * rdx + rdy * rdy);
                if (rdist > 0) { e.x += (rdx / rdist) * e.speed * game.timeScale * 1.8; e.y += (rdy / rdist) * e.speed * game.timeScale * 1.8; }
                e.chainsawRotation += 0.25 * game.timeScale;
                e.mesh.children.forEach(child => { if (child.geometry && child.geometry.type === 'TorusGeometry') child.rotation.z = e.chainsawRotation; });
                break;
            }
            case 'suicide':
                if (game.player) {
                    const s_dx = game.player.x - e.x, s_dy = game.player.y - e.y;
                    const s_dist = Math.sqrt(s_dx * s_dx + s_dy * s_dy);
                    if (s_dist > 0) { e.x += (s_dx / s_dist) * e.speed * game.timeScale; e.y += (s_dy / s_dist) * e.speed * game.timeScale; }
                }
                break;
        }
        e.mesh.position.set(e.x, e.y, 0);
        if (now - e.lastShot > config.fireRate / game.timeScale) {
            e.lastShot = now;
            if (config.laser) game.enemyBeams.push(createEnemyBeam(e.x, e.y - 0.5));
            else if (!config.chainsaw && !config.suicide) {
                const bdx = game.player ? (game.player.x - e.x) : 0;
                const angle = Math.atan2(-1, bdx * 0.15);
                game.enemyBullets.push(createBullet(e.x, e.y - 0.5, Math.sin(angle) * 0.08, -0.17, false));
            }
        }
        if (game.player && checkCollision(e, game.player) && !playerStats.invulnerable) {
            if (config.suicide) {
                // Kamikaze: deal damage and self-destruct
                handlePlayerHit(Math.ceil(config.damage * getDiffMod().enemyDamageMult));
                createExplosion(e.x, e.y, 0xff6600, 14, 1.5);
                GameFeel.shake(1.0);
                game.score += e.config.score;
                scene.remove(e.mesh);
                ResourceManager.disposeMesh(e.mesh);
                game.enemies.splice(i, 1);
                game.enemiesKilled++;
                continue;
            } else {
                // All other enemy types: deal contact damage with cooldown
                const contactCd = config.chainsaw ? 300 : 800;
                if (!e.contactTimer || now - e.contactTimer > contactCd) {
                    e.contactTimer = now;
                    handlePlayerHit(Math.ceil(config.damage * getDiffMod().enemyDamageMult));
                }
            }
        }
        if (e.y < -12) {
            scene.remove(e.mesh);
            ResourceManager.disposeMesh(e.mesh);
            game.enemies.splice(i, 1);
            game.enemiesKilled++;
        }
    }
}

// ============================================================================
// BOSS UPDATE
// ============================================================================

function updateBoss() {
    if (!game.boss) return;
    const b = game.boss, now = Date.now(), config = b.config;

    // Enrage multiplier — bosses move faster below 30% HP
    const hpRatio = b.health / b.maxHealth;
    const enrage = hpRatio < 0.3 ? 1.6 : hpRatio < 0.55 ? 1.2 : 1.0;

    switch (config.pattern) {
        case 'sweep': b.x = Math.sin(now / (900 / enrage)) * 6.5; break;
        case 'bounce': 
            b.x += Math.sin(now / (400 / enrage)) * 0.12 * enrage; 
            b.y = 6 + Math.sin(now / (600 / enrage)) * 1.6; 
            break;
        case 'teleport': 
            if (now - b.lastAttack > (2500 / enrage)) { 
                b.x = (Math.random() - 0.5) * 11; 
                b.y = 3.5 + Math.random() * 3.5;
                EntityAnimator.flash(b, 100);
                createExplosion(b.x, b.y, 0xff00ff, 4, 0.5);
            } 
            break;
        case 'all': 
            b.x = Math.sin(now / (700 / enrage)) * 5; 
            b.y = 5 + Math.cos(now / (500 / enrage)) * 2.2; 
            break;
        case 'figure8':
            b.x = Math.sin(now / (950 / enrage)) * 6;
            b.y = 5.5 + Math.sin(now / (475 / enrage)) * 1.8;
            break;
        case 'diag_bounce':
            b.x += b.vbx * enrage;
            b.y += b.vby * enrage;
            if (b.x >  7.0 || b.x < -7.0) b.vbx *= -1;
            if (b.y >  7.8 || b.y <  3.5) b.vby *= -1;
            break;
        case 'orbit':
            b.orbitAngle += 0.014 * enrage;
            b.x = Math.cos(b.orbitAngle) * 5.5;
            b.y = 5.5 + Math.sin(b.orbitAngle * 2) * 1.8;
            break;
    }

    // Enrage warnings (one-shot flags)
    if (!b.enraged30 && hpRatio < 0.30) {
        b.enraged30 = true;
        showFloatingText('⚡ ENRAGED ⚡', b.x, b.y + 2, 0xff2200);
        GameFeel.shake(1.0);
        createExplosion(b.x, b.y, 0xff2200, 20, 1.5);
    } else if (!b.enraged55 && hpRatio < 0.55) {
        b.enraged55 = true;
        showFloatingText('! RAGE !', b.x, b.y + 2, 0xff8800);
        GameFeel.shake(0.5);
    }

    if (b.type === 'final') {
        if (now - b.lastTeleport > 3000 + Math.random() * 2000) {
            b.lastTeleport = now;
            b.x = (Math.random() - 0.5) * 10;
            b.y = 4 + Math.random() * 3;
            EntityAnimator.flash(b, 150);
            createExplosion(b.x, b.y, 0x6600ff, 6, 0.6);
        }
    }

    b.mesh.position.set(b.x, b.y, 0);
    b.mesh.rotation.z = Math.sin(now / 500) * 0.1;

    if (b.type === 'final' && !b.hasShieldActivated && b.health <= b.maxHealth * 0.5) {
        b.hasShieldActivated = true;
        b.shieldHealth = Math.floor(b.maxHealth * 0.35);
        b.shieldMax = b.shieldHealth;
        
        const shieldGeo = new THREE.IcosahedronGeometry(2.4, 1);
        const shieldMat = new THREE.MeshBasicMaterial({ 
            color: 0x00ffff, 
            transparent: true, 
            opacity: 0.35, 
            wireframe: true 
        });
        b.shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
        scene.add(b.shieldMesh);
        
        showFloatingText('SHIELD UP!', b.x, b.y + 2.5, 0x00ffff);
        GameFeel.shake(0.6);
    }

    if (b.shieldMesh) {
        b.shieldMesh.position.set(b.x, b.y, 0);
        b.shieldMesh.rotation.y += 0.08;
        b.shieldMesh.rotation.z += 0.04;
        b.shieldMesh.material.opacity = 0.25 + Math.sin(now / 200) * 0.15;
    }

    if (now - b.lastAttack > (config.attackRate || 800) * getDiffMod().bossAttackRateMult / game.timeScale) {
        b.lastAttack = now;
        b.attackPhase = (b.attackPhase + 1);
        
        const _diffAttackMod = getDiffMod();
        let attacks = config.attacks[0] === 'everything' 
            ? ['spread', 'laser', 'horizontal', 'rapid', 'homing', 'spiral', 'summon_minions', 'buzzsaw_swarm', 'laser_snipe', 'barrier_wall', 'spiral_aimed'] 
            : [...config.attacks];
        if (_diffAttackMod.bannedAttacks.length > 0) {
            attacks = attacks.filter(a => !_diffAttackMod.bannedAttacks.includes(a));
            if (attacks.length === 0) attacks = ['spread', 'rapid', 'homing'];
        }
        // Hell mode: extra summon at low boss HP
        if (_diffAttackMod.id === 'hell' && b.health < b.maxHealth * 0.4 && Math.random() < 0.3) {
            attacks.push('summon_minions', 'buzzsaw_swarm');
        }
        const attack = attacks[b.attackPhase % attacks.length];

        switch (attack) {
            case 'spread': {
                const sp = game.player;
                const sBase = sp ? Math.atan2(sp.y - b.y, sp.x - b.x) : -Math.PI / 2;
                for (let i = -2; i <= 2; i++) {
                    const ang = sBase + i * 0.18;
                    game.enemyBullets.push(createBullet(b.x, b.y - 1, Math.cos(ang) * 0.12, Math.sin(ang) * 0.12, false));
                }
                break;
            }
            
            case 'laser': 
                for (let i = 0; i < 3; i++) 
                    setTimeout(() => { game.enemyBeams.push(createEnemyBeam(b.x - 1 + i, b.y - 1)); }, i * 150); 
                break;

            case 'horizontal': {
                const dir = Math.random() > 0.5 ? 1 : -1;
                const pRef = game.player;
                const hy = pRef ? pRef.y + (Math.random() - 0.5) * 2.5 : -4 + (Math.random() - 0.5) * 3;
                game.enemyBeams.push(createHorizontalBeam(hy, dir));
                if (Math.random() < 0.45) {
                    setTimeout(() => {
                        if (!game.boss) return;
                        const pRef2 = game.player;
                        const hy2 = pRef2 ? pRef2.y + (Math.random() - 0.5) * 2.5 : hy - 1.5;
                        game.enemyBeams.push(createHorizontalBeam(hy2, -dir));
                    }, 600);
                }
                break;
            }
            
            case 'rapid': 
                for (let i = 0; i < 5; i++) 
                    setTimeout(() => { 
                        if (!game.boss || !game.player) return;
                        const rp = game.player;
                        const rdx = rp.x - b.x, rdy = rp.y - b.y;
                        const rd = Math.sqrt(rdx*rdx + rdy*rdy) || 1;
                        const jitter = (Math.random() - 0.5) * 0.25;
                        game.enemyBullets.push(createBullet(b.x, b.y - 1, (rdx/rd)*0.15 + jitter, (rdy/rd)*0.15, false));
                    }, i * 60); 
                break;
            
            case 'homing': { 
                const hb = createBullet(b.x, b.y - 1, 0, -0.08, false); 
                hb.isHoming = true; 
                game.enemyBullets.push(hb); 
                break; 
            }
            
            case 'spiral': 
                for (let i = 0; i < 8; i++) { 
                    const angle = (Math.PI * 2 / 8) * i + now / 1000; 
                    game.enemyBullets.push(createBullet(b.x, b.y - 1, Math.cos(angle) * 0.1, Math.sin(angle) * 0.1, false)); 
                } 
                break;

            case 'summon_minions': {
                // Boss spawns 3 fast chasers that target the player
                showFloatingText('SUMMONING!', b.x, b.y + 2, 0xff0000);
                GameFeel.shake(0.4);
                const minionTypes = ['fast', 'chaser', 'suicide'];
                for (let m = 0; m < 3; m++) {
                    setTimeout(() => {
                        if (!game.boss) return;
                        const angle = (Math.PI * 2 / 3) * m + now / 1000;
                        const mx = b.x + Math.cos(angle) * 2;
                        const my = b.y + Math.sin(angle) * 1.5;
                        const mType = minionTypes[m % minionTypes.length];
                        const minion = createEnemy(mType, mx, my);
                        EntityAnimator.spawn(minion, 350);
                        game.enemies.push(minion);
                        createExplosion(mx, my, 0xff0000, 6, 0.6);
                    }, m * 200);
                }
                break;
            }

            case 'buzzsaw_swarm': {
                // Spawn 4 buzzsaws orbiting the boss briefly, then hurl toward player
                showFloatingText('BUZZSAW!', b.x, b.y + 2, 0xffaa00);
                const buzzCount = 4;
                for (let bz = 0; bz < buzzCount; bz++) {
                    const orbitAngle0 = (Math.PI * 2 / buzzCount) * bz;
                    const delay = bz * 120;
                    setTimeout(() => {
                        if (!game.boss || !game.player) return;
                        // A fast bullet that starts orbiting then homes
                        const bx = b.x + Math.cos(orbitAngle0) * 2.0;
                        const by = b.y + Math.sin(orbitAngle0) * 1.5;
                        const p = game.player;
                        const ddx = p.x - bx, ddy = p.y - by;
                        const dd = Math.sqrt(ddx*ddx + ddy*ddy) || 1;
                        const buzz = createBullet(bx, by, (ddx/dd)*0.17, (ddy/dd)*0.17, false);
                        buzz.isHoming = true;
                        buzz.mesh.scale.set(1.8, 1.8, 1.8);
                        game.enemyBullets.push(buzz);
                        createExplosion(bx, by, 0xffaa00, 5, 0.5);
                    }, delay);
                }
                break;
            }

            case 'laser_snipe': {
                // Pre-aim laser warning, then 2 fast vertical beams at player X
                if (!game.player) break;
                const snipeX = game.player.x;
                showFloatingText('⚡ SNIPE ⚡', snipeX, b.y - 1, 0xff00ff);
                // Warning jitter — thin beam telegraphs location
                setTimeout(() => {
                    if (!game.boss || !game.player) return;
                    const finalX = game.player.x; // lock on last-second position
                    game.enemyBeams.push(createEnemyBeam(finalX - 0.3, b.y - 0.5, 1800));
                    game.enemyBeams.push(createEnemyBeam(finalX + 0.3, b.y - 0.5, 1800));
                }, 550);
                break;
            }

            case 'barrier_wall': {
                // Two slow horizontal beams that form a closing gate; leave a gap above or below player
                if (!game.player) break;
                const p = game.player;
                const gap = Math.random() < 0.5 ? p.y + 1.5 : p.y - 1.5;
                // Three horizontal beams at different Ys with a gap at player's level
                [-3, -5, -1].forEach((offset, idx) => {
                    const wallY = p.y + offset;
                    if (Math.abs(wallY - gap) < 1.2) return; // leave the gap
                    setTimeout(() => {
                        if (!game.boss) return;
                        const d2 = idx % 2 === 0 ? 1 : -1;
                        game.enemyBeams.push(createHorizontalBeam(wallY, d2));
                    }, idx * 250);
                });
                break;
            }

            case 'spiral_aimed': {
                // Rotating spiral that ALSO fires 2 aimed bullets at player mid-burst
                const saCount = 8;
                for (let i = 0; i < saCount; i++) {
                    const angle = (Math.PI * 2 / saCount) * i + now / 900;
                    game.enemyBullets.push(createBullet(b.x, b.y - 1, Math.cos(angle) * 0.10, Math.sin(angle) * 0.10, false));
                }
                setTimeout(() => {
                    if (!game.boss || !game.player) return;
                    const p2 = game.player;
                    const adx = p2.x - b.x, ady = p2.y - b.y;
                    const ad = Math.sqrt(adx*adx + ady*ady) || 1;
                    for (let k = 0; k < 2; k++) {
                        const hb2 = createBullet(b.x, b.y - 1, (adx/ad)*0.18, (ady/ad)*0.18, false);
                        hb2.isHoming = true;
                        game.enemyBullets.push(hb2);
                    }
                }, 300);
                break;
            }
            case 'flower': {
                // Multi-layer rotating flower: 2 rings of 6 petals, offset and delayed
                const petals = 6;
                for (let layer = 0; layer < 2; layer++) {
                    const rotOffset = (layer / 2) * (Math.PI / petals) + now / 2200;
                    const spd = 0.09 + layer * 0.03;
                    setTimeout(() => {
                        for (let i = 0; i < petals; i++) {
                            const ang = (Math.PI * 2 / petals) * i + rotOffset;
                            game.enemyBullets.push(createBullet(b.x, b.y - 0.5, Math.cos(ang) * spd, Math.sin(ang) * spd, false));
                        }
                    }, layer * 220);
                }
                break;
            }

            case 'vortex': {
                // 12 bullets fired in staggered outward spiral, each a bit faster
                const vCount = 12;
                for (let i = 0; i < vCount; i++) {
                    setTimeout(() => {
                        if (!game.boss) return;
                        const ang = (Math.PI * 2 / vCount) * i + (b.attackPhase * 0.45);
                        const spd = 0.06 + i * 0.007;
                        game.enemyBullets.push(createBullet(b.x, b.y - 0.5, Math.cos(ang) * spd, Math.sin(ang) * spd, false));
                    }, i * 35);
                }
                break;
            }

            case 'ring': {
                // Dense ring of 18 bullets — every direction
                const rCount = 18;
                for (let i = 0; i < rCount; i++) {
                    const ang = (Math.PI * 2 / rCount) * i;
                    game.enemyBullets.push(createBullet(b.x, b.y - 0.5, Math.cos(ang) * 0.11, Math.sin(ang) * 0.11, false));
                }
                break;
            }

            case 'phase_trail': {
                // Boss flickers to 3 new positions, spraying 8 bullets each time
                for (let t = 0; t < 3; t++) {
                    setTimeout(() => {
                        if (!game.boss || game.boss !== b) return;
                        b.x = (Math.random() - 0.5) * 10;
                        b.y = 4.5 + Math.random() * 2.5;
                        EntityAnimator.flash(b, 120);
                        createExplosion(b.x, b.y, 0x8800ff, 6, 0.8);
                        GameFeel.shake(0.3);
                        for (let i = 0; i < 8; i++) {
                            const ang = (Math.PI * 2 / 8) * i;
                            game.enemyBullets.push(createBullet(b.x, b.y, Math.cos(ang) * 0.09, Math.sin(ang) * 0.09, false));
                        }
                    }, t * 420);
                }
                break;
            }

            // ── BOSS 5 — NEBULA TYRANT ────────────────────────────────────
            case 'supernova': {
                // 24-bullet nova ring, then 2 homing orbs follow
                const novaCount = 24;
                for (let i = 0; i < novaCount; i++) {
                    const ang = (Math.PI * 2 / novaCount) * i;
                    game.enemyBullets.push(createBullet(b.x, b.y, Math.cos(ang) * 0.13, Math.sin(ang) * 0.13, false));
                }
                setTimeout(() => {
                    if (!game.boss) return;
                    for (let k = 0; k < 2; k++) {
                        const hb = createBullet(b.x + (k - 0.5) * 1.2, b.y - 1, 0, -0.07, false);
                        hb.isHoming = true;
                        game.enemyBullets.push(hb);
                    }
                }, 700);
                break;
            }

            case 'buzzsaw_rain': {
                // 4 spinning volleys of 5 bullets each, rotated by attack phase
                for (let v = 0; v < 4; v++) {
                    setTimeout(() => {
                        if (!game.boss) return;
                        const base = v * (Math.PI / 4) + b.attackPhase * 0.6;
                        for (let i = 0; i < 5; i++) {
                            const ang = base + i * (Math.PI * 2 / 5);
                            game.enemyBullets.push(createBullet(b.x, b.y, Math.cos(ang) * 0.11, Math.sin(ang) * 0.11, false));
                        }
                    }, v * 160);
                }
                break;
            }

            case 'cross_laser': {
                // 3 vertical beams + 2 crossing horizontal sweeps
                for (let i = 0; i < 3; i++)
                    setTimeout(() => { if (!game.boss) return; game.enemyBeams.push(createEnemyBeam(b.x - 1.2 + i * 1.2, b.y - 1)); }, i * 120);
                setTimeout(() => {
                    if (!game.boss) return;
                    game.enemyBeams.push(createHorizontalBeam(b.y - 2,  1));
                    game.enemyBeams.push(createHorizontalBeam(b.y - 3.5, -1));
                }, 500);
                break;
            }

            case 'twin_spiral': {
                // Two spirals spinning in opposite directions simultaneously
                const tCount = 7;
                for (let i = 0; i < tCount; i++) {
                    const ang1 =  (Math.PI * 2 / tCount) * i + now / 700;
                    const ang2 = -(Math.PI * 2 / tCount) * i - now / 700;
                    game.enemyBullets.push(createBullet(b.x, b.y - 0.5, Math.cos(ang1) * 0.10, Math.sin(ang1) * 0.10, false));
                    game.enemyBullets.push(createBullet(b.x, b.y - 0.5, Math.cos(ang2) * 0.10, Math.sin(ang2) * 0.10, false));
                }
                break;
            }

            // ── BOSS 6 — ECLIPSE SOVEREIGN ────────────────────────────────
            case 'pulse_wave': {
                // 3 concentric rings fired in sequence, each faster and denser
                for (let ring = 0; ring < 3; ring++) {
                    setTimeout(() => {
                        if (!game.boss) return;
                        const pCount = 10 + ring * 5;
                        const spd = 0.07 + ring * 0.03;
                        for (let i = 0; i < pCount; i++) {
                            const ang = (Math.PI * 2 / pCount) * i + ring * 0.2;
                            game.enemyBullets.push(createBullet(b.x, b.y, Math.cos(ang) * spd, Math.sin(ang) * spd, false));
                        }
                    }, ring * 380);
                }
                break;
            }

            case 'sniper_burst': {
                // 3 fast leading shots that predict player position
                for (let i = 0; i < 3; i++) {
                    setTimeout(() => {
                        if (!game.boss || !game.player) return;
                        const p = game.player;
                        const dx = p.x - b.x, dy = p.y - b.y;
                        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                        const travelT = dist / 0.22;
                        const tx = p.x + (p.vx || 0) * travelT * 0.6;
                        const ty = p.y + (p.vy || 0) * travelT * 0.6;
                        const ldx = tx - b.x, ldy = ty - b.y;
                        const ld = Math.sqrt(ldx * ldx + ldy * ldy) || 1;
                        game.enemyBullets.push(createBullet(b.x, b.y - 0.5, (ldx / ld) * 0.22, (ldy / ld) * 0.22, false));
                    }, i * 260);
                }
                break;
            }

            case 'cage': {
                // 4 slow corner bullets, then a closing ring after a pause
                const corners = [[-6.5, -6.5], [6.5, -6.5], [-6.5, 6.5], [6.5, 6.5]];
                corners.forEach(([tx, ty]) => {
                    const dx = tx - b.x, dy = ty - b.y;
                    const d = Math.sqrt(dx * dx + dy * dy) || 1;
                    game.enemyBullets.push(createBullet(b.x, b.y, (dx / d) * 0.07, (dy / d) * 0.07, false));
                });
                setTimeout(() => {
                    // Fast aimed burst to punish staying still
                    if (!game.boss || !game.player) return;
                    for (let k = 0; k < 4; k++) {
                        setTimeout(() => {
                            if (!game.boss || !game.player) return;
                            const dx = game.player.x - b.x, dy = game.player.y - b.y;
                            const d = Math.sqrt(dx * dx + dy * dy) || 1;
                            game.enemyBullets.push(createBullet(b.x, b.y - 0.5, (dx / d) * 0.14, (dy / d) * 0.14, false));
                        }, k * 110);
                    }
                }, 650);
                break;
            }
        }
    }

    // ── ANNIHILATOR — separate slow laser timer (10 s on, 1.5 s beam) ────
    if (b.type === 'mini3') {
        const laserRate     = config.laserRate     || 10000;
        const laserDuration = config.laserDuration || 1500;
        if (now - b.lastLaserAttack > laserRate) {
            b.lastLaserAttack = now;
            showFloatingText('LASER!', b.x, b.y + 2, 0xff00ff);
            for (let i = 0; i < 3; i++) {
                setTimeout(() => {
                    if (!game.boss || game.boss !== b) return;
                    game.enemyBeams.push(createEnemyBeam(b.x - 1 + i, b.y - 1, laserDuration));
                }, i * 150);
            }
        }
    }
}

// ============================================================================
// BULLETS UPDATE
// ============================================================================

function updateBullets() {
    for (let i = game.bullets.length - 1; i >= 0; i--) {
        const b = game.bullets[i];
        // Soft homing: gently steer player bullets toward the closest enemy within ~1.5 units horizontally
        if (b.isPlayer && !b.isLaser && game.enemies.length > 0) {
            let nearest = null, nearestDist = 0.9;  // tighter detection window
            for (const e of game.enemies) {
                const hdx = Math.abs(e.x - b.x);
                if (e.y < b.y) continue;
                if (hdx < nearestDist) { nearestDist = hdx; nearest = e; }
            }
            if (!nearest && game.boss) {
                const hdx = Math.abs(game.boss.x - b.x);
                if (hdx < nearestDist && game.boss.y > b.y) nearest = game.boss;
            }
            if (nearest) {
                const pull = 0.0018 * (1 - nearestDist / 0.9); // much gentler nudge
                b.vx += (nearest.x - b.x > 0 ? 1 : -1) * pull;
                b.vx = Math.max(-0.09, Math.min(0.09, b.vx)); // tight sideways cap
            }
        }
        b.x += b.vx * game.timeScale; b.y += b.vy * game.timeScale;
        b.mesh.position.set(b.x, b.y, 0);
        let hit = false;
        for (let j = game.enemies.length - 1; j >= 0; j--) {
            const e = game.enemies[j];
            if (checkCollision(b, e)) {
                e.health -= b.damage; hit = true;
                EntityAnimator.flash(e, 50);
                createExplosion(b.x, b.y, 0xffffff, 3, 0.4);
                showFloatingText('-' + b.damage, b.x, b.y, 0xffffff);
                if (e.health <= 0) {
                    killEnemy(e, j);
                }
                break;
            }
        }
        if (game.boss && checkCollision(b, game.boss)) {
            hit = true;
            applyDamageToBoss(b.damage, b.x, b.y);
        }
        if (hit || b.y > 10) {
            scene.remove(b.mesh);
            ResourceManager.disposeMesh(b.mesh);
            game.bullets.splice(i, 1);
        }
    }
    for (let i = game.enemyBullets.length - 1; i >= 0; i--) {
        const b = game.enemyBullets[i];
        if (b.isHoming && game.player) {
            const pulse = 0.75 + Math.abs(Math.sin(Date.now() / 120)) * 0.5;
            b.mesh.scale.set(pulse, pulse, pulse);
            b.mesh.rotation.z += 0.15 * game.timeScale;
            const dx = game.player.x - b.x, dy = game.player.y - b.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                b.vx += (dx / dist) * 0.002 * game.timeScale;
                b.vy += (dy / dist) * 0.002 * game.timeScale;
                const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
                if (speed > 0.15) { b.vx = (b.vx / speed) * 0.15; b.vy = (b.vy / speed) * 0.15; }
            }
        }
        b.x += b.vx * game.timeScale; b.y += b.vy * game.timeScale;
        b.mesh.position.set(b.x, b.y, 0);
        if (b.isBomb && b.y < -5) {
            createExplosion(b.x, b.y, 0xff4400, 18, 1.2);
            GameFeel.shake(0.8);
            for (let k = 0; k < 8; k++) { const angle = (Math.PI * 2 / 8) * k; game.enemyBullets.push(createBullet(b.x, b.y, Math.cos(angle) * 0.1, Math.sin(angle) * 0.1, false)); }
        }
        if (game.player && checkCollision(b, game.player) && !playerStats.invulnerable) {
            handlePlayerHit(Math.ceil(b.damage * getDiffMod().enemyDamageMult));
            scene.remove(b.mesh);
            ResourceManager.disposeMesh(b.mesh);
            game.enemyBullets.splice(i, 1);
            continue;
        }
        if (b.y < -10 || b.y > 10 || Math.abs(b.x) > 10) {
            scene.remove(b.mesh);
            ResourceManager.disposeMesh(b.mesh);
            game.enemyBullets.splice(i, 1);
        }
    }
}

// ============================================================================
// POWERUPS UPDATE
// ============================================================================

function updatePowerups() {
    const now = Date.now();
    for (let i = game.powerups.length - 1; i >= 0; i--) {
        const p = game.powerups[i];
        p.y += p.vy * game.timeScale;
        p.mesh.position.set(p.x, p.y, 0);
        p.mesh.rotation.z += 0.02 * game.timeScale;
        p.mesh.rotation.y = Math.sin(now / 300 + p.bobOffset) * 0.3;
        p.mesh.position.z = Math.sin(now / 400 + p.bobOffset) * 0.2;

        if (game.player && playerStats.magnetRadius > 0) {
            const dx = game.player.x - p.x, dy = game.player.y - p.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < playerStats.magnetRadius * 3 && dist > 0.1) {
                const pullSpeed = 0.08 * game.timeScale;
                p.x += (dx / dist) * pullSpeed;
                p.y += (dy / dist) * pullSpeed;
            }
        }
        if (game.player && checkCollision(p, game.player)) {
            applyPowerup(p.type, p.config);
            scene.remove(p.mesh);
            ResourceManager.disposeMesh(p.mesh);
            game.powerups.splice(i, 1);
            continue;
        }
        if (p.y < -10) {
            scene.remove(p.mesh);
            ResourceManager.disposeMesh(p.mesh);
            game.powerups.splice(i, 1);
        }
    }
}

function applyPowerup(type, config) {
    SoundManager.play('powerup', 0.5);
    switch (type) {
        case 'scoreSmall': case 'scoreMedium': case 'scoreLarge':
            game.score += config.value;
            showFloatingText(`+${config.value}`, game.player.x, game.player.y, 0xffd700);
            break;
        case 'health':
            if (playerStats.health < playerStats.maxHealth) playerStats.health++;
            else if (playerStats.maxHealth < 10) { playerStats.maxHealth++; playerStats.health = playerStats.maxHealth; }
            showFloatingText('+HP', game.player.x, game.player.y, 0xff0000);
            break;
        case 'attackSpeed':
            playerStats.attackSpeed = Math.min(playerStats.attackSpeed + 0.15, 2.0);
            showFloatingText('ATK SPD UP', game.player.x, game.player.y, 0xffff00);
            break;
        case 'laser':
            playerStats.laserLevel = Math.min(playerStats.laserLevel + 1, 4);
            showFloatingText('LASER UP', game.player.x, game.player.y, 0x00ffff);
            break;
        case 'shotgun':
            playerStats.shotgunLevel = Math.min(playerStats.shotgunLevel + 1, 3);
            showFloatingText('SHOTGUN UP', game.player.x, game.player.y, 0xff00ff);
            break;
        case 'timeSlow':
            game.timeScale = 0.3;
            game.timeSlowEnd = Date.now() + 2500;
            showFloatingText('TIME SLOW', game.player.x, game.player.y, 0x00ff00);
            break;
        case 'nuke':
            playerStats.nukeCount++;
            showFloatingText(`NUKE x${playerStats.nukeCount} (Press C)`, game.player.x, game.player.y, 0xffffff);
            break;
        case 'chainsaw':
            playerStats.chainsawLevel = Math.min(playerStats.chainsawLevel + 1, 3);
            showFloatingText('BUZZSAW UP', game.player.x, game.player.y, 0xaaaaaa);
            break;
        case 'barrier':
            playerStats.barrier = true;
            showFloatingText('BARRIER UP', game.player.x, game.player.y, 0x00ffff);
            break;
        case 'magnet':
            playerStats.magnetRadius = Math.min(playerStats.magnetRadius + 1, 3);
            showFloatingText('MAGNET UP', game.player.x, game.player.y, 0x0000ff);
            break;
        case 'dash':
            playerStats.dashLevel++;
            const newCooldown = Math.max(400, 3000 - (playerStats.dashLevel - 1) * 325);
            showFloatingText(`DASH LVL ${playerStats.dashLevel} (${(newCooldown/1000).toFixed(1)}s)`, game.player.x, game.player.y, 0xffa500);
            break;
        case 'drone':
            playerStats.droneLevel = Math.min(playerStats.droneLevel + 1, 3);
            showFloatingText('DRONE ACQUIRED', game.player.x, game.player.y, 0x00ff00);
            break;
    }
    updateUI();
}

// ============================================================================
// NUKE
// ============================================================================

function activateNuke() {
    if (!game.isPlaying || game.isPaused || playerStats.nukeCount <= 0) return;
    playerStats.nukeCount--;
    showFloatingText('NUKE ACTIVATED!', game.player.x, game.player.y, 0xffffff);
    SoundManager.play('nuke', 0.8);
    SoundManager.play('explosion', 0.6);
    GameFeel.shake(3.0);
    GameFeel.hitStop(12);

    const blackholeMesh = new THREE.Mesh(ResourceManager.getSphere(0.1, 32, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.9 }));
    blackholeMesh.position.set(0, 0, 0);
    scene.add(blackholeMesh);
    game.nukeEffect = { mesh: blackholeMesh, scale: 0.1, maxScale: 15, duration: 2000, startTime: Date.now() };

    const nukedCount = game.enemies.length;
    for (const e of game.enemies) {
        createExplosion(e.x, e.y, 0xffffff, 15, 1.5);
        game.score += e.config.score;
    }
    game.enemies.forEach(e => { scene.remove(e.mesh); ResourceManager.disposeMesh(e.mesh); });
    game.enemies = [];
    game.enemyBullets.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.enemyBullets = [];
    game.enemyBeams.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.enemyBeams = [];

    // Fix wave-completion: account for nuked enemies and stop queued spawns
    game.enemiesKilled += nukedCount;
    if (game.waveInProgress && !game.boss) {
        // Snap both counters to totalEnemiesInWave so queued setTimeouts become no-ops
        game.totalEnemiesSpawned = game.totalEnemiesInWave;
        game.enemiesKilled     = game.totalEnemiesInWave;
    }

    updateUI();
}

function updateNukeEffect() {
    if (!game.nukeEffect) return;
    const now = Date.now();
    const elapsed = now - game.nukeEffect.startTime;
    const progress = elapsed / game.nukeEffect.duration;
    if (progress < 1) {
        const currentScale = game.nukeEffect.maxScale * Math.sin(progress * Math.PI);
        game.nukeEffect.mesh.scale.set(currentScale, currentScale, currentScale);
        game.nukeEffect.mesh.rotation.y += 0.1;
        game.nukeEffect.mesh.rotation.x += 0.05;
        for (let i = game.enemies.length - 1; i >= 0; i--) {
            const e = game.enemies[i];
            const dx = 0 - e.x, dy = 0 - e.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > 0) {
                const pullForce = (1 - progress) * 0.3;
                e.x += (dx / dist) * pullForce * game.timeScale;
                e.y += (dy / dist) * pullForce * game.timeScale;
                e.mesh.position.set(e.x, e.y, 0);
            }
            if (dist < 1) {
                createExplosion(e.x, e.y, 0xffffff, 8, 1.0);
                game.score += e.config.score;
                scene.remove(e.mesh);
                ResourceManager.disposeMesh(e.mesh);
                game.enemies.splice(i, 1);
                game.enemiesKilled++;
            }
        }
    } else {
        scene.remove(game.nukeEffect.mesh);
        ResourceManager.disposeMesh(game.nukeEffect.mesh);
        game.nukeEffect = null;
    }
}

// ============================================================================
// FLOATING TEXT
// ============================================================================

function showFloatingText(text, x, y, color) {
    const div = document.createElement('div');
    div.textContent = text;
    const hexColor = typeof color === 'number' ? '#' + color.toString(16).padStart(6, '0') : color;
    div.style.cssText = `position:absolute;left:50%;top:50%;color:${hexColor};font-size:20px;font-weight:bold;text-shadow:0 0 10px currentColor;pointer-events:none;z-index:1000;transform:translate(-50%,-50%);transition:all 1s ease-out`;
    document.getElementById('ui').appendChild(div);
    const vector = new THREE.Vector3(x, y, 0);
    vector.project(camera);
    div.style.left = (vector.x * 0.5 + 0.5) * window.innerWidth + 'px';
    div.style.top = (-vector.y * 0.5 + 0.5) * window.innerHeight + 'px';
    requestAnimationFrame(() => {
        div.style.transform = 'translate(-50%, -150%) scale(1.2)';
        div.style.opacity = '0';
    });
    setTimeout(() => div.remove(), 1000);
}

// ============================================================================
// PARTICLES UPDATE
// ============================================================================

function updateParticles() {
    for (let i = game.particles.length - 1; i >= 0; i--) {
        const p = game.particles[i];
        p.x += p.vx * game.timeScale;
        p.y += p.vy * game.timeScale;
        p.vx *= p.drag;
        p.vy *= p.drag;
        p.vy += p.gravity * game.timeScale;
        p.life -= 16 * game.timeScale;
        p.mesh.position.set(p.x, p.y, 0);
        p.mesh.rotation.z += p.rotSpeed * game.timeScale;

        if (p.isFlash) {
            p.mesh.material.opacity = (p.life / p.maxLife) * 0.8;
            p.mesh.scale.setScalar(1 + (1 - p.life / p.maxLife) * 2);
        } else {
            const scale = p.life / p.maxLife;
            p.mesh.scale.set(scale, scale, scale);
        }

        if (p.life <= 0) {
            scene.remove(p.mesh);
            if (p.isFlash && p.mesh.material) {
                p.mesh.material.dispose();
            }
            // NEVER dispose geometry — it comes from ResourceManager pool
            game.particles.splice(i, 1);
        }
    }
}

function checkCollision(a, b) {
    const aw = a.width || 0.4, ah = a.height || 0.4;
    const bw = b.width || 0.6, bh = b.height || 0.6;
    return Math.abs(a.x - b.x) < (aw + bw) / 2 && Math.abs(a.y - b.y) < (ah + bh) / 2;
}

function updateStars() {
    game.stars.forEach(stars => {
        stars.rotation.y += 0.0005 * game.timeScale;
        const positions = stars.geometry.attributes.position.array;
        for (let i = 1; i < positions.length; i += 3) {
            positions[i] -= 0.05 * game.timeScale;
            if (positions[i] < -50) positions[i] = 50;
        }
        stars.geometry.attributes.position.needsUpdate = true;
    });
}

// ============================================================================
// UI
// ============================================================================

function updateUI() {
    document.getElementById('score').textContent = game.score.toLocaleString();
    document.getElementById('wave').textContent = game.wave;
    document.getElementById('enemies').textContent = game.enemies.length;
    document.getElementById('health').textContent = playerStats.health;
    document.getElementById('atkSpeed').textContent = playerStats.attackSpeed.toFixed(1);
    document.getElementById('lasers').textContent = playerStats.laserLevel > 0 ? `LVL ${playerStats.laserLevel}` : 'OFF';

    const indicator = document.getElementById('powerupIndicator');
    if (!indicator) return;
    indicator.innerHTML = '';

    const addIcon = (borderColor, textColor, text) => {
        const div = document.createElement('div');
        div.style.cssText = `border-color:${borderColor};color:${textColor};display:inline-block;padding:4px 8px;border:1px solid;margin:2px;font-weight:bold;font-size:12px;font-family:monospace`;
        div.textContent = text;
        indicator.appendChild(div);
    };

    if (playerStats.barrier) addIcon('#0ff', '#0ff', 'B');
    if (playerStats.chainsawLevel > 0) addIcon('#888', '#f00', 'C' + playerStats.chainsawLevel);
    if (playerStats.shotgunLevel > 0) addIcon('#f0f', '#f0f', 'SG');
    if (playerStats.magnetRadius > 0) addIcon('#00f', '#00f', 'M');
    if (playerStats.droneLevel > 0) addIcon('#0f0', '#0f0', 'DR' + playerStats.droneLevel);

    if (playerStats.dashLevel > 0) {
        const now = Date.now();
        const remaining = Math.max(0, playerStats.dashCooldown - now);
        if (remaining > 0) {
            addIcon('#444', '#888', `D:${(remaining/1000).toFixed(1)}s`);
        } else {
            addIcon('#ffa500', '#ffa500', 'D:READY');
        }
    }

    if (playerStats.nukeCount > 0) {
        addIcon('#fff', '#fff', `N:x${playerStats.nukeCount}`);
    }
}

function togglePause() {
    if (!game.isPlaying) return;
    game.isPaused = !game.isPaused;
    if (game.isPaused) showFloatingText('PAUSED', 0, 0, 0xffffff);
}

function toggleGodMode() {
    game.godMode = !game.godMode;
    const btn = document.getElementById('godModeBtn');
    const indicator = document.getElementById('godModeIndicator');
    if (game.godMode) {
        if (btn) { btn.textContent = 'GOD MODE: ON'; btn.style.borderColor = '#ffd700'; btn.style.color = '#ffd700'; btn.style.boxShadow = '0 0 15px #ffd700'; }
        if (indicator) indicator.style.display = 'block';
        if (game.player) showFloatingText('☆ GOD MODE ON ☆', game.player.x, game.player.y, 0xffd700);
    } else {
        if (btn) { btn.textContent = 'GOD MODE: OFF'; btn.style.borderColor = '#888'; btn.style.color = '#888'; btn.style.boxShadow = 'none'; }
        if (indicator) indicator.style.display = 'none';
        if (game.player) showFloatingText('GOD MODE OFF', game.player.x, game.player.y, 0x888888);
    }
}

// ============================================================================
// RESET / GAME OVER / WIN
// ============================================================================

function resetGame() {
    game.enemies.forEach(e => { scene.remove(e.mesh); ResourceManager.disposeMesh(e.mesh); });
    game.bullets.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.enemyBullets.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.particles.forEach(p => { scene.remove(p.mesh); if (p.isFlash && p.mesh.material) p.mesh.material.dispose(); });
    game.powerups.forEach(p => { scene.remove(p.mesh); ResourceManager.disposeMesh(p.mesh); });
    game.enemyBeams.forEach(b => { scene.remove(b.mesh); ResourceManager.disposeMesh(b.mesh); });
    game.playerLasers.forEach(l => { scene.remove(l.mesh); ResourceManager.disposeMesh(l.mesh); });
    game.chainsaws.forEach(c => { scene.remove(c.mesh); ResourceManager.disposeMesh(c.mesh); });
    game.drones.forEach(d => { scene.remove(d.mesh); ResourceManager.disposeMesh(d.mesh); });
    if (game.player) { scene.remove(game.player.mesh); ResourceManager.disposeMesh(game.player.mesh); }
    if (game.boss) { 
        if (game.boss.shieldMesh) {
            scene.remove(game.boss.shieldMesh);
            ResourceManager.disposeMesh(game.boss.shieldMesh);
        }
        scene.remove(game.boss.mesh); 
        ResourceManager.disposeMesh(game.boss.mesh); 
    }
    if (game.barrierMesh) { scene.remove(game.barrierMesh); ResourceManager.disposeMesh(game.barrierMesh); }
    if (game.nukeEffect) { scene.remove(game.nukeEffect.mesh); ResourceManager.disposeMesh(game.nukeEffect.mesh); }

    game.score = 0; game.wave = 1; game.isPlaying = false; game.isPaused = false;
    game.player = null; game.enemies = []; game.bullets = []; game.enemyBullets = [];
    game.particles = []; game.powerups = []; game.boss = null; game.waveInProgress = false;
    game.enemiesKilled = 0; game.totalEnemiesInWave = 0; game.totalEnemiesSpawned = 0;
    game.timeScale = 1; game.timeSlowEnd = 0; game.playerLasers = []; game.chainsaws = [];
    game.drones = []; game.enemyBeams = []; game.barrierMesh = null; game.nukeEffect = null;

    playerStats.maxHealth = 5; playerStats.health = 5; playerStats.speed = 0.15;
    playerStats.attackSpeed = 1.2; playerStats.laserLevel = 0; playerStats.shotgunLevel = 0;
    playerStats.chainsawLevel = 0; playerStats.droneLevel = 0; playerStats.barrier = false;
    playerStats.invulnerable = false; playerStats.invulnerableEnd = 0; playerStats.autoLaserTimer = 0;
    playerStats.magnetRadius = 0; playerStats.dashLevel = 0; playerStats.dashCooldown = 0;
    playerStats.isDashing = false; playerStats.nukeCount = 0;
}

function gameOver() {
    game.isPlaying = false;
    SoundManager.stopMusic();
    const rank = HighScoreManager.saveScore(game.playerName, game.score, game.wave, false);
    const isHigh = rank < 10;

    document.getElementById('finalScore').textContent = game.score.toLocaleString();
    document.getElementById('finalPlayerName').textContent = game.playerName;
    document.getElementById('finalWave').textContent = game.wave;
    document.getElementById('endTitle').textContent = 'GAME OVER';
    document.getElementById('endTitle').style.color = '#f00';

    const newHighEl = document.getElementById('newHighScore');
    if (isHigh) {
        newHighEl.style.display = 'block';
        newHighEl.textContent = 'NEW HIGH SCORE! #' + (rank + 1);
    } else {
        newHighEl.style.display = 'none';
    }

    renderLeaderboardTable(document.getElementById('leaderboardBody'));
    document.getElementById('gameOver').style.display = 'block';
ARManager.start('lose');
}

function gameWin() {
    game.isPlaying = false;
    SoundManager.stopMusic();
    const rank = HighScoreManager.saveScore(game.playerName, game.score, game.wave, true);
    const isHigh = rank < 10;

    document.getElementById('finalScore').textContent = game.score.toLocaleString();
    document.getElementById('finalPlayerName').textContent = game.playerName;
    document.getElementById('finalWave').textContent = game.wave;
    document.getElementById('endTitle').textContent = 'VICTORY!';
    document.getElementById('endTitle').style.color = '#0ff';

    const newHighEl = document.getElementById('newHighScore');
    if (isHigh) {
        newHighEl.style.display = 'block';
        newHighEl.textContent = 'NEW HIGH SCORE! #' + (rank + 1);
    } else {
        newHighEl.style.display = 'none';
    }

    renderLeaderboardTable(document.getElementById('leaderboardBody'));
    document.getElementById('gameOver').style.display = 'block';
  ARManager.start('win');
}

// ============================================================================
// MAIN LOOP
// ============================================================================

function animate() {
    requestAnimationFrame(animate);
    if (!game.isPlaying || game.isPaused) return;

    if (GameFeel.hitStopFrames > 0) {
        GameFeel.hitStopFrames--;
        return;
    }

    if (game.timeScale < 1 && Date.now() > game.timeSlowEnd) game.timeScale = 1;

    updateStars();
    updatePlayer();
    updatePlayerLasers();
    updateChainsaws();
    updateDrones();
    updateBarrier();
    updateEnemies();
    updateBoss();
    updateBullets();
    updateEnemyBeams();
    updatePowerups();
    updateParticles();
    updateNukeEffect();
    EntityAnimator.update();
    GameFeel.update(camera, cameraBasePos);

    if (game.waveInProgress && !game.boss && game.enemies.length === 0 && game.enemiesKilled >= game.totalEnemiesSpawned && game.totalEnemiesSpawned > 0) {
        waveComplete();
    }
    renderer.render(scene, camera);
}

// ============================================================================
// START GAME
// ============================================================================

function startGame() {
    if (typeof THREE === 'undefined') {
        alert('Three.js not loaded. Check your internet connection or use a local copy of three.js.');
        return;
    }
    if (window.gameBootError) {
        alert('Game failed to initialize: ' + window.gameBootError);
        return;
    }
    if (!scene) {
        alert('Game scene not initialized. Check console for errors.');
        return;
    }
    const nameInput = document.getElementById('playerName');
    const name = nameInput ? nameInput.value.trim() : '';
    game.playerName = name || 'PILOT';

    ARManager.stop();
    resetGame();
    SoundManager.init();
    SoundManager.playMusic('sounds/bg_music.mp3');
    document.getElementById('startScreen').style.display = 'none';
    document.getElementById('gameOver').style.display = 'none';
    document.getElementById('leaderboardScreen').style.display = 'none';
    game.isPlaying = true;
    game.player = createPlayer();
    
     ARManager.init();
    startWave();
    animate();
}

// ============================================================================
// LEADERBOARD & SCORE EXPORT
// ============================================================================

function renderLeaderboardTable(tbody) {
    if (!tbody) return;
    const scores = HighScoreManager.getLeaderboard(10);
    tbody.innerHTML = '';
    if (scores.length === 0) {
        const row = document.createElement('tr');
        row.innerHTML = '<td colspan="5" style="padding:20px;color:#888;text-align:center;">NO SCORES YET. BE THE FIRST!</td>';
        tbody.appendChild(row);
        return;
    }
    scores.forEach((entry, index) => {
        const row = document.createElement('tr');
        const rankColor = index === 0 ? '#ffd700' : index === 1 ? '#c0c0c0' : index === 2 ? '#cd7f32' : '#0ff';
        const statusColor = entry.won ? '#0f0' : '#f00';
        row.innerHTML = `
            <td style="padding:8px;text-align:center;color:${rankColor};font-weight:bold;border-bottom:1px solid rgba(0,255,255,0.3);">${index + 1}</td>
            <td style="padding:8px;text-align:center;border-bottom:1px solid rgba(0,255,255,0.3);">${entry.name}</td>
            <td style="padding:8px;text-align:center;border-bottom:1px solid rgba(0,255,255,0.3);color:#ffd700;">${entry.score.toLocaleString()}</td>
            <td style="padding:8px;text-align:center;border-bottom:1px solid rgba(0,255,255,0.3);">${entry.wave}</td>
            <td style="padding:8px;text-align:center;border-bottom:1px solid rgba(0,255,255,0.3);color:${statusColor};">${entry.won ? 'VICTORY' : 'DEFEAT'}</td>
        `;
        tbody.appendChild(row);
    });
}

function exportScores() {
    const scores = HighScoreManager.getScores();
    const dataStr = JSON.stringify(scores, null, 2);
    const blob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cosmic_bullet_hell_scores.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function clearScores() {
    if (confirm('ERASE ALL SAVED SCORES?')) {
        HighScoreManager.clear();
        alert('SCORES CLEARED');
    }
}

function showLeaderboardFromStart() {
    renderLeaderboardTable(document.getElementById('leaderboardBodyStart'));
    document.getElementById('leaderboardScreen').style.display = 'flex';
}

function hideLeaderboard() {
    document.getElementById('leaderboardScreen').style.display = 'none';
}

function closeAR() {
    ARManager.stop();
}

function returnToMenu() {
    ARManager.stop();
    document.getElementById('gameOver').style.display = 'none';
    document.getElementById('startScreen').style.display = 'flex';
    game.isPlaying = false;
    game.isPaused = false;
}

window.addEventListener('resize', () => {
    if (camera && renderer) {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }
});
// ============================================================================
// AR MANAGER — TensorFlow.js FaceMesh Integration
// ============================================================================

const ARManager = {
    video: null,
    canvas: null,
    ctx: null,
    faceMesh: null,
    isRunning: false,
    animId: null,
    mode: 'win',
    lastResults: null,

    async init() {
        if (this.video) return;
        this.video = document.getElementById('arVideo');
        this.canvas = document.getElementById('arCanvas');
        if (!this.video || !this.canvas) return;
        this.ctx = this.canvas.getContext('2d');

        try {
            let stream = null;

            // 1) Enumerate devices — pick a real webcam, skip DroidCam / virtual cameras
            try {
                const devices = await navigator.mediaDevices.enumerateDevices();
                const videoDevices = devices.filter(d => d.kind === 'videoinput');
                // Prefer a device that is NOT DroidCam or a virtual/OBS camera
                const virtualLabels = /droidcam|obs|virtual|manycam|vcam|snap camera|epoccam/i;
                const realCam = videoDevices.find(d => d.label && !virtualLabels.test(d.label));
                const targetDevice = realCam || videoDevices[0]; // fallback to first
                if (targetDevice) {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { deviceId: { exact: targetDevice.deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
                    });
                }
            } catch (_) {}

            // 2) Progressive fallback if enumeration failed
            if (!stream) {
                const attempts = [
                    { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                    { facingMode: 'user' },
                    {}
                ];
                for (const constraints of attempts) {
                    try {
                        stream = await navigator.mediaDevices.getUserMedia({ video: constraints });
                        break;
                    } catch (_) {}
                }
            }

            if (!stream) throw new Error('No camera available');
            this.video.srcObject = stream;
            await this.video.play();

            // Load MediaPipe FaceMesh (TF.js runtime)
            if (typeof FaceMesh !== 'undefined') {
                this.faceMesh = new FaceMesh({ locateFile: (file) => {
                    return `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`;
                }});
                this.faceMesh.setOptions({
                    maxNumFaces: 1,
                    refineLandmarks: false,
                    minDetectionConfidence: 0.5,
                    minTrackingConfidence: 0.5
                });
                this.faceMesh.onResults((results) => { this.lastResults = results; });
            }
        } catch (err) {
            console.warn('AR Init warning:', err);
        }
    },

    async processFrame() {
        if (!this.isRunning) return;
        if (this.faceMesh && this.video.readyState >= 2) {
            try { await this.faceMesh.send({ image: this.video }); } catch (e) {}
        }
        this.draw();
        this.animId = requestAnimationFrame(() => this.processFrame());
    },

    draw() {
        const ctx = this.ctx;
        const cvs = this.canvas;
        cvs.width = window.innerWidth;
        cvs.height = window.innerHeight;
        const w = cvs.width;
        const h = cvs.height;

        ctx.clearRect(0, 0, w, h);

        // Mirrored webcam feed (fill screen, cover mode)
        if (this.video.readyState >= 2) {
            ctx.save();
            ctx.translate(w, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(this.video, 0, 0, w, h);
            ctx.restore();
        }

        // Scanline overlay for "game feel"
        ctx.fillStyle = 'rgba(0, 255, 255, 0.025)';
        for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);

        let centerX = w / 2;
        let topY = h * 0.10;    // pushed higher on screen
        let faceW = w * 0.25;
        let faceH = h * 0.25;

        // If FaceMesh gave us landmarks, compute head position
        if (this.lastResults && this.lastResults.multiFaceLandmarks && this.lastResults.multiFaceLandmarks.length > 0) {
            const lm = this.lastResults.multiFaceLandmarks[0];
            let minX = 1, minY = 1, maxX = 0, maxY = 0;
            for (const p of lm) {
                minX = Math.min(minX, p.x);
                minY = Math.min(minY, p.y);
                maxX = Math.max(maxX, p.x);
                maxY = Math.max(maxY, p.y);
            }
            faceW = (maxX - minX) * w;
            faceH = (maxY - minY) * h;
            centerX = (1 - (minX + maxX) / 2) * w; // mirror X
            topY = minY * h;

            if (this.mode === 'win') {
                this.drawCrown(ctx, centerX, topY - faceH * 0.30, faceW * 1.4, faceH * 0.75);
                this.drawSparkles(ctx, centerX, topY - faceH * 0.35, faceW);
            } else {
                this.drawDunceCap(ctx, centerX, topY - faceH * 0.30, faceW * 1.1, faceH * 0.85);
                this.drawTears(ctx, lm, w, h);
                this.drawFrown(ctx, lm, w, h);
            }
        } else {
            // Fallback: centered if no face detected
            if (this.mode === 'win') {
                this.drawCrown(ctx, centerX, topY, w * 0.22, h * 0.16);
                this.drawSparkles(ctx, centerX, topY, w * 0.25);
            } else {
                this.drawDunceCap(ctx, centerX, topY, w * 0.18, h * 0.2);
            }
        }

        // Mode label
        ctx.font = `bold ${Math.floor(h * 0.04)}px 'Courier New', monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        if (this.mode === 'win') {
            ctx.fillStyle = '#ffd700';
            ctx.shadowColor = '#ffd700';
            ctx.shadowBlur = 20;
            ctx.fillText('★ VICTORY ★', w / 2, h * 0.05);
        } else {
            ctx.fillStyle = '#ff4444';
            ctx.shadowColor = '#ff0000';
            ctx.shadowBlur = 20;
            ctx.fillText('DEFEAT', w / 2, h * 0.05);
        }
        ctx.shadowBlur = 0;
    },

    drawCrown(ctx, x, y, w, h) {
        const t = Date.now() / 600;
        const bounce = Math.sin(t) * 10;
        y += bounce;

        ctx.save();
        ctx.translate(x, y);

        // Crown body
        ctx.fillStyle = '#ffd700';
        ctx.strokeStyle = '#b8860b';
        ctx.lineWidth = Math.max(2, w * 0.02);

        ctx.beginPath();
        const peaks = 5;
        const step = w / (peaks - 1);
        ctx.moveTo(-w / 2, h * 0.5);
        for (let i = 0; i < peaks; i++) {
            const px = -w / 2 + i * step;
            const tipX = px + step * 0.5;
            const tipY = (i % 2 === 0) ? -h * 0.45 : -h * 0.2;
            if (i === 0) ctx.lineTo(px, h * 0.5);
            ctx.lineTo(tipX, tipY);
            ctx.lineTo(px + step, h * 0.5);
        }
        ctx.lineTo(w / 2, h * 0.75);
        ctx.lineTo(-w / 2, h * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Band
        ctx.fillStyle = '#ffec8b';
        ctx.fillRect(-w / 2, h * 0.5, w, h * 0.25);

        // Jewels
        ctx.fillStyle = '#ff2222';
        ctx.beginPath(); ctx.arc(0, h * 0.15, w * 0.07, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#22aaff';
        [-1, 1].forEach(d => {
            ctx.beginPath(); ctx.arc(d * w * 0.28, h * 0.32, w * 0.05, 0, Math.PI * 2); ctx.fill();
        });

        // Shine reflection
        ctx.fillStyle = 'rgba(255,255,220,0.35)';
        ctx.beginPath(); ctx.ellipse(-w * 0.15, -h * 0.15, w * 0.08, h * 0.12, -0.5, 0, Math.PI * 2); ctx.fill();

        ctx.restore();
    },

    drawSparkles(ctx, x, y, size) {
        const t = Date.now() / 300;
        for (let i = 0; i < 8; i++) {
            const angle = (i / 8) * Math.PI * 2 + t * 0.5;
            const dist = size * 0.7 + Math.sin(t * 2 + i) * size * 0.25;
            const sx = x + Math.cos(angle) * dist;
            const sy = y + Math.sin(angle) * dist * 0.5;
            const r = 3 + Math.sin(t * 3 + i) * 2;
            ctx.fillStyle = `rgba(255, 215, 0, ${0.5 + Math.sin(t + i) * 0.5})`;
            ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.fill();
        }
    },

    drawDunceCap(ctx, x, y, w, h) {
        const t = Date.now() / 450;
        const wobble = Math.sin(t) * 6;

        ctx.save();
        ctx.translate(x + wobble, y);

        // Cap body
        ctx.fillStyle = '#4a4a6a';
        ctx.strokeStyle = '#222233';
        ctx.lineWidth = 2;

        ctx.beginPath();
        ctx.moveTo(-w / 2, h * 0.75);
        ctx.quadraticCurveTo(-w * 0.35, -h * 0.1, -w * 0.08, -h * 0.45);
        ctx.lineTo(w * 0.08, -h * 0.45);
        ctx.quadraticCurveTo(w * 0.35, -h * 0.1, w / 2, h * 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Rim
        ctx.fillStyle = '#333355';
        ctx.beginPath();
        ctx.ellipse(0, h * 0.75, w * 0.55, w * 0.12, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Big L
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.floor(h * 0.35)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('L', 0, h * 0.25);

        ctx.restore();
    },

    drawTears(ctx, landmarks, w, h) {
        // Left eye ~33, Right eye ~263 in MediaPipe FaceMesh
        const left = landmarks[33];
        const right = landmarks[263];
        if (!left || !right) return;

        const t = Date.now() / 500;
        const eyes = [
            { x: (1 - left.x) * w, y: left.y * h },
            { x: (1 - right.x) * w, y: right.y * h }
        ];

        eyes.forEach((eye, i) => {
            const tearY = eye.y + 30 + Math.sin(t + i * 2.5) * 5;
            const alpha = 0.5 + Math.sin(t * 2 + i) * 0.3;
            ctx.fillStyle = `rgba(0, 170, 255, ${alpha})`;
            ctx.beginPath();
            ctx.ellipse(eye.x, tearY, 5, 10, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.fillStyle = `rgba(255,255,255,${alpha})`;
            ctx.beginPath(); ctx.arc(eye.x - 2, tearY - 4, 2, 0, Math.PI * 2); ctx.fill();
        });
    },

    drawFrown(ctx, landmarks, w, h) {
        const topLip = landmarks[13];
        const bottomLip = landmarks[14];
        if (!topLip || !bottomLip) return;
        const mx = (1 - (topLip.x + bottomLip.x) / 2) * w;
        const my = ((topLip.y + bottomLip.y) / 2) * h;

        ctx.strokeStyle = 'rgba(80,80,120,0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(mx, my - 8, 18, 0.25, Math.PI - 0.25);
        ctx.stroke();
    },

    start(mode) {
        this.mode = mode;
        if (this.isRunning) return;
        this.isRunning = true;
        this.canvas.style.display = 'block';
        const closeBtn = document.getElementById('arCloseBtn');
        if (closeBtn) closeBtn.style.display = 'block';
        this.processFrame();
    },

    stop() {
        this.isRunning = false;
        if (this.animId) cancelAnimationFrame(this.animId);
        if (this.canvas) this.canvas.style.display = 'none';
        const closeBtn = document.getElementById('arCloseBtn');
        if (closeBtn) closeBtn.style.display = 'none';
    }
};