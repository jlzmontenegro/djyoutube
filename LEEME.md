# DJ YouTube

Consola de DJ con dos bandejas que reproducen **videos de YouTube** o **tus propios archivos de música**,
mezclador, sampler, micrófono, efectos de video y una ventana de proyección para otra pantalla del mismo PC.

En línea: **https://jlzmontenegro.github.io/djyoutube/** (o, en local, con `Iniciar DJ YouTube.bat`).
Usa **Chrome o Edge**.

## Uso básico

- **Agregar canciones:** pega enlaces de YouTube (videos o listas) y pulsa *Agregar*, o pulsa
  **+ Mis MP3** (también puedes arrastrar los archivos a la lista o a una bandeja).
  Tus MP3 se guardan en este navegador.
- **Buscar:** con una clave de la API de YouTube (*Ajustes*) buscas dentro de la app; sin clave, usa *Abrir YouTube ↗*.
- **Cargar:** botones **A** / **B**, arrastrar a la bandeja, o doble clic (va a la bandeja que no está al aire).
- **Cola, historial y ficha:** *+Cola* pone una canción a sonar después; la pestaña *Historial* guarda lo que
  sonó (exportable a texto o Excel); **✎** abre la ficha (BPM, tonalidad Camelot, energía, etiquetas, notas)
  para filtrar y ordenar la lista.

## Bandejas

- Play/Pausa, CUE (estilo CDJ), ±5 s, 4 hot cues, loops IN/OUT y de 4/8/16 tiempos.
- **Tiempos y compases:** con el BPM (TAP, o automático en los MP3) y el **tiempo 1** (botón *1*), cada bandeja
  muestra 1-2-3-4 y el compás de la frase. **Q** (quantize) hace que cues, hot cues y loops caigan exactos en el tiempo.
- **Tempo:** YouTube en pasos de 5 %; MP3 continuo ±16 % con *key lock* (sin cambiar el tono).
  ◀ ▶ frenan/aceleran un poco mientras los mantienes, para empatar golpes a mano.
- **SYNC:** iguala tempo y fase con la otra bandeja. Con MP3 es exacto; con YouTube tarda unos segundos
  y mantiene los golpes a pocos milisegundos alternando entre dos velocidades.
- **FX de mezcla:** GATE (cortes al ritmo), FRENO (de tocadiscos) y ECHO OUT (eco que se apaga y pausa).
- **Solo con MP3** (YouTube no deja procesar su audio): ecualizador de 3 bandas, filtro, eco/reverb/flanger,
  forma de onda (arrástrala para mover la canción), BPM automático y **PFL** (pre-escucha por audífonos).

## Mezclador

Volumen de A, B y master con **medidores** (nivel real en los MP3), crossfader con 3 curvas, **medidor de fase**,
*Auto-fade*, *AutoMix* y el paso automático a la siguiente canción justo antes de las miniaturas de YouTube.

## Extras

- **Sampler:** 8 pads (bocina, sirena, láser, subida, impacto, bombo, palmas, rebobinar), generados por la app;
  cada pad puede cargar un sonido tuyo.
- **Micrófono:** con *talkover*, la música baja sola mientras hablas.
- **Efectos de video:** filtros, espejo, zoom, estrobo y flash al ritmo, pulso, transición fundido/cortina/deslizar,
  logo y texto que pasa. Las bandejas MP3 se ven como un visualizador que reacciona a la música.
- **Audífonos:** elige la salida para la pre-escucha (PFL) de los MP3.
- **Controladora MIDI:** pulsa *Aprender* y mueve el control de tu controladora (cualquier marca).

## Proyectar

1. Conecta el proyector en modo **Extender** (Windows + P).
2. Pulsa **Abrir proyección** y haz doble clic en ella (o tecla **F**) para pantalla completa.

El sonido sale de la consola, no de la proyección. Para Zoom/Meet/OBS comparte la ventana de proyección.

## Atajos de teclado

| Tecla | Acción |
|---|---|
| Q / W · P / O | Play-pausa / CUE de A · de B |
| 1–4 · 7–0 | Hot cues de A · de B (Mayús + número: borrar) |
| ← → / ↓ | Mover / centrar el crossfader |
| F · N | Auto-fade · Pantalla negra |
| Z X C V A S D G | Pads del sampler |
| M · J · K | Micrófono · Estrobo · Flash al ritmo |

## Limitaciones de YouTube

- Puede poner **anuncios**: la app no los bloquea, pero los hace pasar en silencio al preparar la siguiente
  canción y los oculta en la proyección. Sin anuncios: **YouTube Premium** con tu cuenta abierta en el navegador.
- Las **miniaturas del final** no se pueden quitar: la proyección oculta ese tramo y la siguiente canción entra antes.
- Algunos videos **no permiten** reproducirse fuera de YouTube (salen como *NO DISPONIBLE*).
- Sin ecualizador, efectos de audio, forma de onda ni pre-escucha en las bandejas de YouTube: para eso usa MP3.
- Las listas y tus MP3 se guardan en el navegador: usa *Exportar* para copiar las listas a otro PC.
