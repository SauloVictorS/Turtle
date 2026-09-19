/**
 * Turtle — extensão MakeCode para o Keyestudio Micro:bit Mini Smart Turtle Car
 * Modelos KS4014 / KS4024
 *
 * CONDECOMA — Projeto Azurita Conectada
 * https://github.com/SauloVictorS/Turtle
 *
 * Os blocos ficam em cinco gavetas na paleta, em vez de uma só:
 *   Carro     → andar, virar e parar
 *   Luzes     → os 2 LEDs RGB da placa e os 4 faróis da frente
 *   Sensores  → linha, distância e os eventos que eles disparam
 *   Controle  → o controle remoto infravermelho
 *   Avançado  → calibração, som e diagnóstico (fora do caminho da turma)
 *
 * Mapa de pinos (conforme manual Keyestudio):
 *   P0  → buzzer passivo
 *   P1  → Trig do sensor ultrassônico
 *   P2  → Echo do sensor ultrassônico
 *   P8  → 4 LEDs WS2812 (faróis)
 *   P11 → receptor infravermelho  (ATENÇÃO: mesmo pino do botão B do micro:bit)
 *   P14 → sensor de linha esquerdo
 *   P15 → sensor de linha central
 *   P16 → sensor de linha direito
 *   I2C → PCA9685 (endereço 0x47): motores e os 2 LEDs RGB da placa
 */

/**
 * Cores dos LEDs RGB e dos faróis
 */
enum COLOR {
    //% block="vermelho"
    red,
    //% block="verde"
    green,
    //% block="azul"
    blue,
    //% block="amarelo"
    yellow,
    //% block="ciano"
    cyan,
    //% block="rosa"
    magenta,
    //% block="branco"
    white,
    //% block="apagado"
    black
}

/**
 * Direção do carro
 */
enum DIR {
    //% block="para frente"
    Run_forward = 0,
    //% block="para trás"
    Run_back = 1,
    //% block="girando para a esquerda"
    Turn_Left = 2,
    //% block="girando para a direita"
    Turn_Right = 3
}

/**
 * Lado esquerdo ou direito
 */
enum LR {
    //% block="lado esquerdo"
    LeftSide = 0,
    //% block="lado direito"
    RightSide = 1
}

/**
 * Como o carro para
 */
enum MotorState {
    //% block="parar"
    stop = 0,
    //% block="frear"
    brake = 1
}

/**
 * Sensores de linha
 */
enum LT {
    //% block="esquerda"
    Left = 0,
    //% block="centro"
    Center = 1,
    //% block="direita"
    Right = 2
}

/**
 * Nível digital que representa "linha detectada"
 */
enum LINE_LEVEL {
    //% block="0"
    Low = 0,
    //% block="1"
    High = 1
}


// =========================================================================
// PEÇAS INTERNAS
//
// Este namespace não tem nenhum bloco, então não aparece na paleta. Ele
// guarda o que as cinco categorias precisam dividir entre si: o chip
// PCA9685 (que comanda motores E LEDs RGB ao mesmo tempo), a tira de
// faróis e a calibração. Os alunos nunca veem isto; o professor mexe aqui
// se precisar mudar hardware.
// =========================================================================

namespace turtleHw {

    // ---- PCA9685 --------------------------------------------------------

    const PCA9685_ADDRESS = 0x47;
    const MODE1 = 0x00;
    const PRESCALE = 0xFE;
    const LED0_ON_L = 0x06;

    // 50 Hz é frequência de servo. Motor DC em 50 Hz chia e não tem torque
    // em velocidade baixa. ~1 kHz resolve os dois problemas.
    const PWM_FREQ = 1000;

    // Canais do PCA9685
    export const CH_ESQ_PWM = 0, CH_ESQ_A = 1, CH_ESQ_B = 2;
    export const CH_DIR_PWM = 5, CH_DIR_A = 4, CH_DIR_B = 3;
    const CH_LED_ESQ_R = 9, CH_LED_ESQ_G = 10, CH_LED_ESQ_B = 11;
    const CH_LED_DIR_R = 7, CH_LED_DIR_G = 6, CH_LED_DIR_B = 8;

    let PCA9685_Initialized = false;

    function i2cRead(addr: number, reg: number): number {
        pins.i2cWriteNumber(addr, reg, NumberFormat.UInt8BE);
        return pins.i2cReadNumber(addr, NumberFormat.UInt8BE);
    }

    function i2cWrite(addr: number, reg: number, value: number): void {
        const buf = pins.createBuffer(2);
        buf[0] = reg;
        buf[1] = value;
        pins.i2cWriteBuffer(addr, buf);
    }

    function setFreq(freq: number): void {
        let prescaleval = 25000000;
        prescaleval /= 4096;
        prescaleval /= freq;
        prescaleval -= 1;
        // o registrador é inteiro — arredondar é obrigatório
        const prescale = Math.floor(prescaleval + 0.5);

        const oldmode = i2cRead(PCA9685_ADDRESS, MODE1);
        const newmode = (oldmode & 0x7F) | 0x10;   // dormir
        i2cWrite(PCA9685_ADDRESS, MODE1, newmode);
        i2cWrite(PCA9685_ADDRESS, PRESCALE, prescale);
        i2cWrite(PCA9685_ADDRESS, MODE1, oldmode);
        control.waitMicros(5000);
        i2cWrite(PCA9685_ADDRESS, MODE1, oldmode | 0xa1);
    }

    export function setPwm(channel: number, on: number, off: number): void {
        const buf = pins.createBuffer(5);
        buf[0] = LED0_ON_L + 4 * channel;
        buf[1] = on & 0xff;
        buf[2] = (on >> 8) & 0xff;
        buf[3] = off & 0xff;
        buf[4] = (off >> 8) & 0xff;
        pins.i2cWriteBuffer(PCA9685_ADDRESS, buf);
    }

    /**
     * Toda função pública chama isto. Assim não importa qual bloco o aluno
     * usa primeiro — a placa sempre está pronta.
     */
    export function iniciar(): void {
        if (PCA9685_Initialized) return;
        i2cWrite(PCA9685_ADDRESS, MODE1, 0x00);
        setFreq(PWM_FREQ);
        for (let idx = 0; idx < 16; idx++) {
            setPwm(idx, 0, 0);
        }
        PCA9685_Initialized = true;
    }

    // ---- Motores --------------------------------------------------------

    let trimEsq = 0;        // compensação por motor, em %
    let trimDir = 0;
    let velMin = 0;         // velocidade mínima em que o motor realmente gira

    export function definirTrim(esquerda: number, direita: number): void {
        trimEsq = Math.constrain(esquerda, -50, 50);
        trimDir = Math.constrain(direita, -50, 50);
    }

    export function definirVelocidadeMinima(v: number): void {
        velMin = Math.constrain(v, 0, 60);
    }

    function velocidadeReal(speed: number, trim: number): number {
        if (speed <= 0) return 0;
        let v = speed * (100 + trim) / 100;
        if (v < velMin) v = velMin;
        return Math.constrain(v, 0, 100);
    }

    function pwmDaVelocidade(speed: number, trim: number): number {
        return Math.round(Math.map(velocidadeReal(speed, trim), 0, 100, 0, 4095));
    }

    export function acionarEsquerdo(speed: number, paraTras: boolean): void {
        setPwm(CH_ESQ_PWM, 0, pwmDaVelocidade(speed, trimEsq));
        setPwm(CH_ESQ_A, 0, paraTras ? 4095 : 0);
        setPwm(CH_ESQ_B, 0, paraTras ? 0 : 4095);
    }

    export function acionarDireito(speed: number, paraTras: boolean): void {
        setPwm(CH_DIR_PWM, 0, pwmDaVelocidade(speed, trimDir));
        setPwm(CH_DIR_A, 0, paraTras ? 4095 : 0);
        setPwm(CH_DIR_B, 0, paraTras ? 0 : 4095);
    }

    // ---- Cores e LEDs RGB da placa --------------------------------------

    let L_brightness = 4095;

    export function definirBrilhoDosLeds(br: number): void {
        L_brightness = Math.round(Math.map(Math.constrain(br, 0, 255), 0, 255, 0, 4095));
    }

    export function corHex(col: COLOR): number {
        switch (col) {
            case COLOR.red: return 0xFF0000;
            case COLOR.green: return 0x00FF00;
            case COLOR.blue: return 0x0000FF;
            case COLOR.yellow: return 0xFFFF00;
            case COLOR.cyan: return 0x00FFFF;
            case COLOR.magenta: return 0xFF00FF;
            case COLOR.white: return 0xFFFFFF;
            default: return 0x000000;
        }
    }

    export function aplicarLed(lado: LR, r: number, g: number, b: number): void {
        const R = Math.round(Math.map(r, 0, 255, 0, L_brightness));
        const G = Math.round(Math.map(g, 0, 255, 0, L_brightness));
        const B = Math.round(Math.map(b, 0, 255, 0, L_brightness));
        if (lado == LR.LeftSide) {
            setPwm(CH_LED_ESQ_R, 0, R);
            setPwm(CH_LED_ESQ_G, 0, G);
            setPwm(CH_LED_ESQ_B, 0, B);
        } else {
            setPwm(CH_LED_DIR_R, 0, R);
            setPwm(CH_LED_DIR_G, 0, G);
            setPwm(CH_LED_DIR_B, 0, B);
        }
    }

    // ---- Faróis WS2812 --------------------------------------------------

    export const NUM_FAROIS = 4;
    let farois: neopixel.Strip = null;

    export function tira(): neopixel.Strip {
        if (!farois) {
            farois = neopixel.create(DigitalPin.P8, NUM_FAROIS, NeoPixelMode.RGB);
            farois.setBrightness(60);
            farois.clear();
            farois.show();
        }
        return farois;
    }

    // ---- Sensores de linha ----------------------------------------------

    let nivelDaLinha = 0;     // leitura digital que significa "estou vendo a linha"

    export function definirNivelDaLinha(nivel: number): void {
        nivelDaLinha = nivel;
    }

    export function lerLinha(lt: LT): boolean {
        let bruto = 0;
        switch (lt) {
            case LT.Left: bruto = pins.digitalReadPin(DigitalPin.P14); break;
            case LT.Center: bruto = pins.digitalReadPin(DigitalPin.P15); break;
            default: bruto = pins.digitalReadPin(DigitalPin.P16); break;
        }
        return bruto == nivelDaLinha;
    }
}


// =========================================================================
// CARRO — andar, virar e parar
// =========================================================================

//% color="#ff6800" icon="\uf1b9" weight=100
//% block="Carro"
namespace Carro {

    /**
     * Move o carro numa direção, com velocidade de 0 a 100%.
     */
    //% blockId=turtle_run
    //% block="carro $direction velocidade: $speed \\%"
    //% speed.min=0 speed.max=100 speed.defl=50
    //% weight=100
    export function run(direction: DIR, speed: number): void {
        turtleHw.iniciar();
        switch (direction) {
            case DIR.Run_forward:
                turtleHw.acionarEsquerdo(speed, false);
                turtleHw.acionarDireito(speed, false);
                break;
            case DIR.Run_back:
                turtleHw.acionarEsquerdo(speed, true);
                turtleHw.acionarDireito(speed, true);
                break;
            case DIR.Turn_Left:
                turtleHw.acionarEsquerdo(speed, true);
                turtleHw.acionarDireito(speed, false);
                break;
            case DIR.Turn_Right:
                turtleHw.acionarEsquerdo(speed, false);
                turtleHw.acionarDireito(speed, true);
                break;
        }
    }

    /**
     * Move o carro por um tempo determinado e para sozinho.
     * Útil para as primeiras aulas, antes de o aluno conhecer laços.
     */
    //% blockId=turtle_run_for
    //% block="carro $direction velocidade: $speed \\% por $ms ms"
    //% speed.min=0 speed.max=100 speed.defl=50
    //% ms.shadow=timePicker ms.defl=1000
    //% weight=99
    export function andarPor(direction: DIR, speed: number, ms: number): void {
        run(direction, speed);
        basic.pause(ms);
        state(MotorState.stop);
    }

    /**
     * Controla os dois lados separadamente.
     * Valores negativos fazem a roda girar para trás.
     * É este bloco que permite curvas suaves e controle proporcional.
     */
    //% blockId=turtle_wheels
    //% block="carro esquerda $esquerda \\% direita $direita \\%"
    //% esquerda.min=-100 esquerda.max=100 esquerda.defl=50
    //% direita.min=-100 direita.max=100 direita.defl=50
    //% weight=98
    export function rodas(esquerda: number, direita: number): void {
        turtleHw.iniciar();
        const e = Math.constrain(esquerda, -100, 100);
        const d = Math.constrain(direita, -100, 100);
        turtleHw.acionarEsquerdo(Math.abs(e), e < 0);
        turtleHw.acionarDireito(Math.abs(d), d < 0);
    }

    /**
     * Para o carro.
     * "parar" solta as rodas (o carro desliza um pouco).
     * "frear" trava as rodas (o carro para na hora).
     */
    //% blockId=turtle_state
    //% block="carro $sta"
    //% weight=97
    export function state(sta: MotorState): void {
        turtleHw.iniciar();
        if (sta == MotorState.stop) {          // roda livre
            turtleHw.setPwm(turtleHw.CH_ESQ_PWM, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_ESQ_A, 0, 0);
            turtleHw.setPwm(turtleHw.CH_ESQ_B, 0, 0);
            turtleHw.setPwm(turtleHw.CH_DIR_PWM, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_DIR_A, 0, 0);
            turtleHw.setPwm(turtleHw.CH_DIR_B, 0, 0);
        } else {                                // freio: as duas entradas em nível alto
            turtleHw.setPwm(turtleHw.CH_ESQ_PWM, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_ESQ_A, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_ESQ_B, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_DIR_PWM, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_DIR_A, 0, 4095);
            turtleHw.setPwm(turtleHw.CH_DIR_B, 0, 4095);
        }
    }
}


// =========================================================================
// LUZES — os 2 LEDs RGB da placa e os 4 faróis WS2812 do para-choque
// =========================================================================

//% color="#ffc400" icon="\uf0eb" weight=99
//% block="Luzes"
//% groups="['LEDs do carro', 'Faróis']"
namespace Luzes {

    /**
     * Brilho dos LEDs RGB da placa (0 a 255).
     */
    //% blockId=turtle_led_brightness
    //% block="brilho do LED $br"
    //% br.min=0 br.max=255 br.defl=128
    //% group="LEDs do carro" weight=79
    export function LED_brightness(br: number): void {
        turtleHw.iniciar();
        turtleHw.definirBrilhoDosLeds(br);
    }

    /**
     * Acende um dos LEDs RGB da placa com uma cor pronta.
     */
    //% blockId=turtle_led
    //% block="definir LED RGB do $RgbLed como $col"
    //% group="LEDs do carro" weight=78
    export function Led(RgbLed: LR, col: COLOR): void {
        turtleHw.iniciar();
        const c = turtleHw.corHex(col);
        turtleHw.aplicarLed(RgbLed, (c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF);
    }

    /**
     * Acende os dois LEDs RGB da placa com a mesma cor.
     */
    //% blockId=turtle_both_led
    //% block="definir ambos LEDs RGB como $col"
    //% group="LEDs do carro" weight=77
    export function BothLed(col: COLOR): void {
        Led(LR.LeftSide, col);
        Led(LR.RightSide, col);
    }

    /**
     * Acende um LED RGB da placa misturando vermelho, verde e azul.
     */
    //% blockId=turtle_set_led
    //% block="definir LED RGB do $RgbLed R:$red G:$green B:$blue"
    //% red.min=0 red.max=255 red.defl=255
    //% green.min=0 green.max=255 green.defl=0
    //% blue.min=0 blue.max=255 blue.defl=0
    //% group="LEDs do carro" weight=76
    export function SetLed(RgbLed: LR, red: number, green: number, blue: number): void {
        turtleHw.iniciar();
        turtleHw.aplicarLed(RgbLed, red, green, blue);
    }

    /**
     * Apaga os dois LEDs RGB da placa.
     */
    //% blockId=turtle_off_led
    //% block="desligar todos LEDs RGB"
    //% group="LEDs do carro" weight=75
    export function OFFLed(): void {
        turtleHw.iniciar();
        for (let ch = 6; ch <= 11; ch++) {
            turtleHw.setPwm(ch, 0, 0);
        }
    }

    /**
     * Acende um farol (0 a 3) com uma cor pronta.
     */
    //% blockId=turtle_headlight
    //% block="definir farol $n como $col"
    //% n.min=0 n.max=3 n.defl=0
    //% group="Faróis" weight=68
    export function farol(n: number, col: COLOR): void {
        const s = turtleHw.tira();
        s.setPixelColor(Math.constrain(n, 0, turtleHw.NUM_FAROIS - 1), turtleHw.corHex(col));
        s.show();
    }

    /**
     * Acende os quatro faróis com a mesma cor.
     */
    //% blockId=turtle_all_headlights
    //% block="definir todos os faróis como $col"
    //% group="Faróis" weight=67
    export function todosOsFarois(col: COLOR): void {
        turtleHw.tira().showColor(turtleHw.corHex(col));
    }

    /**
     * Acende um farol misturando vermelho, verde e azul.
     */
    //% blockId=turtle_headlight_rgb
    //% block="definir farol $n com R:$red G:$green B:$blue"
    //% n.min=0 n.max=3 n.defl=0
    //% red.min=0 red.max=255 red.defl=255
    //% green.min=0 green.max=255 green.defl=0
    //% blue.min=0 blue.max=255 blue.defl=0
    //% group="Faróis" weight=66
    export function farolRGB(n: number, red: number, green: number, blue: number): void {
        const s = turtleHw.tira();
        s.setPixelColor(Math.constrain(n, 0, turtleHw.NUM_FAROIS - 1), neopixel.rgb(red, green, blue));
        s.show();
    }

    /**
     * Brilho dos faróis (0 a 255). Valores altos consomem muita bateria.
     */
    //% blockId=turtle_headlight_brightness
    //% block="brilho dos faróis $b"
    //% b.min=0 b.max=255 b.defl=60
    //% group="Faróis" weight=65
    export function brilhoDosFarois(b: number): void {
        const s = turtleHw.tira();
        s.setBrightness(Math.constrain(b, 0, 255));
        s.show();
    }

    /**
     * Pinta os quatro faróis com as cores do arco-íris.
     */
    //% blockId=turtle_headlight_rainbow
    //% block="arco-íris nos faróis"
    //% group="Faróis" weight=64
    export function arcoIrisNosFarois(): void {
        const s = turtleHw.tira();
        s.showRainbow(1, 360);
    }

    /**
     * Apaga os quatro faróis.
     */
    //% blockId=turtle_headlights_off
    //% block="desligar faróis"
    //% group="Faróis" weight=63
    export function desligarFarois(): void {
        const s = turtleHw.tira();
        s.clear();
        s.show();
    }
}


// =========================================================================
// SENSORES — linha, distância e os eventos que eles disparam
// =========================================================================

//% color="#00a3a3" icon="\uf06e" weight=98
//% block="Sensores"
//% groups="['Linha', 'Distância', 'Eventos']"
namespace Sensores {

    let ultimoErro = 0;

    /**
     * Verdadeiro quando aquele sensor está enxergando a linha.
     */
    //% blockId=turtle_sees_line
    //% block="vê linha à $lt"
    //% group="Linha" weight=70
    export function verLinha(lt: LT): boolean {
        return turtleHw.lerLinha(lt);
    }

    /**
     * Onde a linha está em relação ao centro do carro:
     *   -2 = bem à esquerda    -1 = um pouco à esquerda
     *    0 = centralizada
     *   +1 = um pouco à direita  +2 = bem à direita
     * Se o carro perder a linha, o bloco continua devolvendo o último valor
     * conhecido — é isso que faz o robô voltar sozinho para a pista.
     */
    //% blockId=turtle_line_position
    //% block="posição da linha"
    //% group="Linha" weight=69
    export function posicaoDaLinha(): number {
        const e = verLinha(LT.Left) ? 1 : 0;
        const c = verLinha(LT.Center) ? 1 : 0;
        const d = verLinha(LT.Right) ? 1 : 0;

        if (e == 0 && c == 0 && d == 0) return ultimoErro;   // perdeu a linha
        if (e == 1 && c == 1 && d == 1) return 0;            // cruzamento

        let erro = ultimoErro;
        if (e == 0 && c == 1 && d == 0) erro = 0;
        else if (e == 1 && c == 1 && d == 0) erro = -1;
        else if (e == 1 && c == 0 && d == 0) erro = -2;
        else if (e == 0 && c == 1 && d == 1) erro = 1;
        else if (e == 0 && c == 0 && d == 1) erro = 2;

        ultimoErro = erro;
        return erro;
    }

    const DIST_MAX = 255;
    let ultimaDistancia = DIST_MAX;

    /**
     * Distância até o obstáculo, em centímetros.
     * Quando não há nada na frente, devolve 255.
     */
    //% blockId=turtle_ultra
    //% block="distância (cm)"
    //% group="Distância" weight=67
    export function ultra(): number {
        pins.setPull(DigitalPin.P1, PinPullMode.PullNone);
        pins.digitalWritePin(DigitalPin.P1, 0);
        control.waitMicros(2);
        pins.digitalWritePin(DigitalPin.P1, 1);
        control.waitMicros(10);
        pins.digitalWritePin(DigitalPin.P1, 0);

        const t = pins.pulseIn(DigitalPin.P2, PulseValue.High, 25000);
        if (t == 0) {
            // um eco perdido isolado não deve virar leitura falsa
            const anterior = ultimaDistancia;
            ultimaDistancia = DIST_MAX;
            return anterior;
        }
        const cm = Math.round(t / 58);
        ultimaDistancia = cm > DIST_MAX ? DIST_MAX : cm;
        return ultimaDistancia;
    }

    // ---------------------------------------------------------------------
    // Eventos
    // ---------------------------------------------------------------------

    let limiteObstaculo = 15;
    let obstaculoHandler: () => void = null;
    let obstaculoArmado = true;

    let perdaHandler: () => void = null;
    let perdaArmada = true;

    let monitorAtivo = false;

    function iniciarMonitor(): void {
        if (monitorAtivo) return;
        monitorAtivo = true;
        control.inBackground(() => {
            while (true) {
                if (obstaculoHandler) {
                    const d = ultra();
                    if (d < limiteObstaculo) {
                        if (obstaculoArmado) {
                            obstaculoArmado = false;
                            obstaculoHandler();
                        }
                    } else if (d > limiteObstaculo + 3) {
                        obstaculoArmado = true;
                    }
                }
                if (perdaHandler) {
                    const semLinha = !verLinha(LT.Left) && !verLinha(LT.Center) && !verLinha(LT.Right);
                    if (semLinha) {
                        if (perdaArmada) {
                            perdaArmada = false;
                            perdaHandler();
                        }
                    } else {
                        perdaArmada = true;
                    }
                }
                basic.pause(50);
            }
        });
    }

    /**
     * Executa os blocos de dentro quando algo aparece na frente do carro.
     */
    //% blockId=turtle_on_obstacle
    //% block="quando o obstáculo estiver a menos de $cm cm"
    //% cm.min=2 cm.max=200 cm.defl=15
    //% group="Eventos" weight=66
    export function aoDetectarObstaculo(cm: number, handler: () => void): void {
        limiteObstaculo = cm;
        obstaculoHandler = handler;
        iniciarMonitor();
    }

    /**
     * Executa os blocos de dentro quando os três sensores perdem a linha.
     */
    //% blockId=turtle_on_line_lost
    //% block="quando o carro perder a linha"
    //% group="Eventos" weight=65
    export function aoPerderALinha(handler: () => void): void {
        perdaHandler = handler;
        iniciarMonitor();
    }
}


// =========================================================================
// CONTROLE — receptor infravermelho no P11
//
// ATENÇÃO: P11 é o mesmo pino do botão B do micro:bit. Com o receptor
// instalado, não use o botão B no mesmo programa — um atrapalha o outro.
// =========================================================================

//% color="#8e44ad" icon="\uf11b" weight=97
//% block="Controle"
//% groups="['Dirigir', 'Botões']"
namespace Controle {

    let controleIniciado = false;
    let dirigindoPeloControle = false;
    let velocidadeDoControle = 60;
    let direcaoDoControle = -1;

    /**
     * Liga o receptor no protocolo padrão. Não é um bloco: os blocos do
     * controle chamam isto sozinhos.
     */
    export function iniciarControle(): void {
        if (controleIniciado) return;
        makerbit.connectIrReceiver(DigitalPin.P11, IrProtocol.Keyestudio);
        controleIniciado = true;
    }

    /**
     * Usado pelo bloco de protocolo, na categoria Avançado.
     */
    export function ligarNoProtocolo(protocolo: IrProtocol): void {
        makerbit.connectIrReceiver(DigitalPin.P11, protocolo);
        controleIniciado = true;
    }

    function moverPeloControle(d: DIR): void {
        direcaoDoControle = d;
        Carro.run(d, velocidadeDoControle);
    }

    function pararPeloControle(): void {
        direcaoDoControle = -1;
        Carro.state(MotorState.stop);
    }

    function registrarTeclaDeVelocidade(b: IrButton, v: number): void {
        makerbit.onIrButton(b, IrButtonAction.Pressed, () => {
            velocidadeDoControle = v;
            if (direcaoDoControle >= 0) {
                Carro.run(direcaoDoControle, v);
            }
        });
    }

    /**
     * Deixa o carro pronto para ser dirigido pelo controle:
     *   ▲ anda para frente     ▼ anda de ré
     *   ◀ gira à esquerda      ▶ gira à direita
     *   OK para o carro
     *   1 a 9 mudam a velocidade (1 = 10%, 9 = 90%)
     *   * acende os faróis     # apaga os faróis
     * O carro anda enquanto o botão estiver apertado e para quando você solta.
     * Use uma vez, dentro do "ao iniciar".
     */
    //% blockId=turtle_ir_drive
    //% block="dirigir o carro pelo controle com velocidade $speed \\%"
    //% speed.min=10 speed.max=100 speed.defl=60
    //% group="Dirigir" weight=58
    export function dirigirPeloControle(speed: number): void {
        iniciarControle();
        velocidadeDoControle = Math.constrain(speed, 10, 100);
        if (dirigindoPeloControle) return;
        dirigindoPeloControle = true;

        makerbit.onIrButton(IrButton.Up, IrButtonAction.Pressed, () => moverPeloControle(DIR.Run_forward));
        makerbit.onIrButton(IrButton.Down, IrButtonAction.Pressed, () => moverPeloControle(DIR.Run_back));
        makerbit.onIrButton(IrButton.Left, IrButtonAction.Pressed, () => moverPeloControle(DIR.Turn_Left));
        makerbit.onIrButton(IrButton.Right, IrButtonAction.Pressed, () => moverPeloControle(DIR.Turn_Right));
        makerbit.onIrButton(IrButton.Ok, IrButtonAction.Pressed, () => pararPeloControle());

        makerbit.onIrButton(IrButton.Up, IrButtonAction.Released, () => pararPeloControle());
        makerbit.onIrButton(IrButton.Down, IrButtonAction.Released, () => pararPeloControle());
        makerbit.onIrButton(IrButton.Left, IrButtonAction.Released, () => pararPeloControle());
        makerbit.onIrButton(IrButton.Right, IrButtonAction.Released, () => pararPeloControle());

        registrarTeclaDeVelocidade(IrButton.Number_1, 10);
        registrarTeclaDeVelocidade(IrButton.Number_2, 20);
        registrarTeclaDeVelocidade(IrButton.Number_3, 30);
        registrarTeclaDeVelocidade(IrButton.Number_4, 40);
        registrarTeclaDeVelocidade(IrButton.Number_5, 50);
        registrarTeclaDeVelocidade(IrButton.Number_6, 60);
        registrarTeclaDeVelocidade(IrButton.Number_7, 70);
        registrarTeclaDeVelocidade(IrButton.Number_8, 80);
        registrarTeclaDeVelocidade(IrButton.Number_9, 90);

        makerbit.onIrButton(IrButton.Star, IrButtonAction.Pressed, () => Luzes.todosOsFarois(COLOR.white));
        makerbit.onIrButton(IrButton.Hash, IrButtonAction.Pressed, () => Luzes.desligarFarois());
    }

    /**
     * Executa os blocos de dentro no momento em que a tecla é apertada.
     */
    //% blockId=turtle_ir_on_pressed
    //% block="quando o botão $b do controle for pressionado"
    //% b.fieldEditor="gridpicker"
    //% b.fieldOptions.columns=3
    //% b.fieldOptions.tooltips="false"
    //% group="Botões" weight=57
    export function aoPressionarBotao(b: IrButton, handler: () => void): void {
        iniciarControle();
        makerbit.onIrButton(b, IrButtonAction.Pressed, handler);
    }

    /**
     * Executa os blocos de dentro no momento em que a tecla é solta.
     * É aqui que normalmente se manda o carro parar.
     */
    //% blockId=turtle_ir_on_released
    //% block="quando o botão $b do controle for solto"
    //% b.fieldEditor="gridpicker"
    //% b.fieldOptions.columns=3
    //% b.fieldOptions.tooltips="false"
    //% group="Botões" weight=56
    export function aoSoltarBotao(b: IrButton, handler: () => void): void {
        iniciarControle();
        makerbit.onIrButton(b, IrButtonAction.Released, handler);
    }

    /**
     * Número do último botão apertado no controle.
     * Vale -1 enquanto ninguém apertar nada.
     */
    //% blockId=turtle_ir_button
    //% block="botão do controle"
    //% group="Botões" weight=55
    export function botaoDoControle(): number {
        iniciarControle();
        return makerbit.irButton();
    }

    /**
     * O número que identifica uma tecla.
     * Compare com o bloco "botão do controle".
     */
    //% blockId=turtle_ir_button_code
    //% block="código do botão $b"
    //% b.fieldEditor="gridpicker"
    //% b.fieldOptions.columns=3
    //% b.fieldOptions.tooltips="false"
    //% group="Botões" weight=54
    export function codigoDoBotao(b: IrButton): number {
        return makerbit.irButtonCode(b);
    }

    /**
     * Verdadeiro se chegou algum sinal do controle desde a última vez
     * que este bloco foi usado.
     */
    //% blockId=turtle_ir_received
    //% block="recebeu sinal do controle"
    //% group="Botões" weight=53
    export function recebeuSinalDoControle(): boolean {
        iniciarControle();
        return makerbit.wasIrDataReceived();
    }
}


// =========================================================================
// AVANÇADO — calibração, som e diagnóstico
//
// Fica por último na paleta, com cor cinza: é a gaveta do professor.
// Nenhum destes blocos é necessário para a aula rodar.
// =========================================================================

//% color="#6d6d6d" icon="\uf013" weight=96
//% block="Avançado"
//% groups="['Motor', 'Luzes', 'Sensores', 'Controle', 'Som', 'Diagnóstico']"
namespace Avancado {

    /**
     * Corrige o carro que puxa para um lado.
     * Cada chassi tem o número dele: anote e cole na tampa.
     */
    //% blockId=turtle_trim
    //% block="compensar motor esquerdo $esquerda \\% direito $direita \\%"
    //% esquerda.min=-50 esquerda.max=50 esquerda.defl=0
    //% direita.min=-50 direita.max=50 direita.defl=0
    //% group="Motor" weight=90
    export function compensarMotores(esquerda: number, direita: number): void {
        turtleHw.definirTrim(esquerda, direita);
    }

    /**
     * Abaixo de uma certa porcentagem o motor não vence o próprio atrito.
     * Este bloco define o piso: qualquer velocidade maior que zero e menor
     * que este valor é elevada até ele.
     */
    //% blockId=turtle_min_speed
    //% block="velocidade mínima do motor $v \\%"
    //% v.min=0 v.max=60 v.defl=30
    //% group="Motor" weight=89
    export function velocidadeMinima(v: number): void {
        turtleHw.definirVelocidadeMinima(v);
    }

    /**
     * A tira de LEDs do carro, já configurada no P8 com 4 LEDs.
     * Use quando quiser os blocos originais da extensão Neopixel.
     */
    //% blockId=turtle_strip
    //% block="tira de faróis do carro"
    //% group="Luzes" weight=69
    export function tiraDeFarois(): neopixel.Strip {
        return turtleHw.tira();
    }

    /**
     * Ajusta a polaridade dos sensores de linha.
     * Cada módulo TCRT5000 sai de fábrica com o potenciômetro num ponto,
     * então nem todo carro lê a linha preta como 0. Teste com o bloco
     * "mostrar sensores de linha" e troque aqui se estiver invertido.
     */
    //% blockId=turtle_line_level
    //% block="linha detectada quando a leitura for $nivel"
    //% group="Sensores" weight=59
    export function configurarNivelDaLinha(nivel: LINE_LEVEL): void {
        turtleHw.definirNivelDaLinha(nivel);
    }

    /**
     * Os três sensores num número de 0 a 7.
     * Cada bit vale 1 quando aquele sensor vê a linha:
     * 4 = esquerda, 2 = centro, 1 = direita.
     */
    //% blockId=turtle_line_tracking
    //% block="sensor de linha"
    //% group="Sensores" weight=58
    export function LineTracking(): number {
        return ((Sensores.verLinha(LT.Left) ? 1 : 0) << 2)
            + ((Sensores.verLinha(LT.Center) ? 1 : 0) << 1)
            + (Sensores.verLinha(LT.Right) ? 1 : 0);
    }

    /**
     * Liga o receptor infravermelho escolhendo o protocolo.
     * Os blocos da categoria Controle já ligam o receptor sozinhos — use
     * este só se o controle não responder e você precisar testar NEC.
     */
    //% blockId=turtle_ir_connect
    //% block="ligar o controle remoto no protocolo $protocolo"
    //% group="Controle" weight=49
    export function ligarControle(protocolo: IrProtocol): void {
        Controle.ligarNoProtocolo(protocolo);
    }

    /**
     * Manda o som para o buzzer do carro em vez do alto-falante do micro:bit.
     * Sem este bloco, no micro:bit V2 o buzzer da placa fica mudo.
     * Use uma vez, no "ao iniciar".
     */
    //% blockId=turtle_use_buzzer
    //% block="usar o buzzer do carro"
    //% group="Som" weight=39
    export function usarBuzzerDoCarro(): void {
        pins.analogSetPitchPin(AnalogPin.P0);
    }

    /**
     * Um bipe curto no buzzer do carro.
     */
    //% blockId=turtle_beep
    //% block="bipar por $ms ms"
    //% ms.shadow=timePicker ms.defl=200
    //% group="Som" weight=38
    export function bipar(ms: number): void {
        music.playTone(988, ms);
    }

    /**
     * Desenha na matriz de LEDs o que os três sensores de linha estão vendo.
     * Coloque dentro de um laço "sempre" para ajustar os potenciômetros.
     */
    //% blockId=turtle_show_line
    //% block="mostrar sensores de linha"
    //% group="Diagnóstico" weight=29
    export function mostrarSensoresDeLinha(): void {
        basic.clearScreen();
        const colunas = [0, 2, 4];
        const sensores = [LT.Left, LT.Center, LT.Right];
        for (let i = 0; i < 3; i++) {
            if (Sensores.verLinha(sensores[i])) {
                for (let y = 0; y < 5; y++) {
                    led.plot(colunas[i], y);
                }
            } else {
                led.plot(colunas[i], 2);
            }
        }
    }

    /**
     * Autoteste do carro: LEDs, faróis, motores e sensores, em sequência.
     * Rode no começo da aula para saber qual robô está com problema
     * antes de os alunos começarem.
     */
    //% blockId=turtle_selftest
    //% block="testar o carro"
    //% group="Diagnóstico" weight=28
    export function testarOCarro(): void {
        basic.showString("T");

        // LEDs RGB da placa
        Luzes.BothLed(COLOR.red); basic.pause(400);
        Luzes.BothLed(COLOR.green); basic.pause(400);
        Luzes.BothLed(COLOR.blue); basic.pause(400);
        Luzes.OFFLed();

        // Faróis
        Luzes.todosOsFarois(COLOR.white); basic.pause(400);
        Luzes.arcoIrisNosFarois(); basic.pause(600);
        Luzes.desligarFarois();

        // Motores, um de cada vez
        basic.showArrow(ArrowNames.West);
        Carro.rodas(40, 0); basic.pause(600); Carro.state(MotorState.stop);
        basic.pause(300);
        basic.showArrow(ArrowNames.East);
        Carro.rodas(0, 40); basic.pause(600); Carro.state(MotorState.stop);
        basic.pause(300);

        // Sensores de linha por 3 segundos
        for (let i = 0; i < 30; i++) {
            mostrarSensoresDeLinha();
            basic.pause(100);
        }

        // Distância
        basic.clearScreen();
        basic.showNumber(Sensores.ultra());
        basic.pause(500);

        // Controle remoto: aperte qualquer tecla nos próximos 4 segundos
        basic.showString("IR");
        let recebeu = false;
        for (let t = 0; t < 40; t++) {
            if (Controle.recebeuSinalDoControle()) {
                recebeu = true;
                break;
            }
            basic.pause(100);
        }
        if (recebeu) {
            basic.showNumber(Controle.botaoDoControle());
            basic.pause(500);
        } else {
            basic.showIcon(IconNames.No);
            basic.pause(500);
        }

        basic.showIcon(IconNames.Yes);
    }
}
