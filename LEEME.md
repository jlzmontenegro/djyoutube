# DJ YouTube

Consola de DJ sencilla que usa videos de YouTube: dos bandejas, mezclador con crossfader,
listas de canciones y una ventana de proyección para mostrar el video en otra pantalla del mismo PC.

## Cómo abrirlo

1. Necesitas **Node.js** (ya está instalado en este PC) y conexión a internet.
2. Haz doble clic en **`Iniciar DJ YouTube.bat`**. Se abre el navegador en `http://localhost:8090`.
3. Deja abierta la ventana negra mientras pinchas. Para salir, ciérrala.

Usa **Chrome o Edge**: con ellos la proyección puede abrirse directamente en el segundo monitor.

## Uso básico

- **Agregar canciones:** pega uno o varios enlaces de YouTube en la barra y pulsa *Agregar*.
  Para traer una lista completa, pega su enlace (`youtube.com/playlist?list=…`).
- **Buscar:** con una clave de la API de YouTube (⚙ Ajustes) puedes escribir y buscar dentro de la app.
  Sin clave, usa *Abrir YouTube ↗*, busca y copia el enlace.
- **Cargar en una bandeja:** botones **A** / **B** de cada canción, arrastrarla a la bandeja,
  o doble clic (la carga en la bandeja que no está al aire).
- **Bandejas:** Play/Pausa, CUE (estilo CDJ), saltos de ±5 s, 4 hot cues, loop IN/OUT,
  loops de 4/8/16 tiempos (después de medir el BPM con TAP) y velocidad (tempo).
  Los cues, hot cues y BPM se guardan por canción.
- **Mezclador:** volumen de A, B y master, crossfader con 3 curvas, *Auto-fade* y *AutoMix*
  (mezcla sola la lista con el tiempo de fundido elegido).

## Proyectar el video

1. Conecta el proyector o la segunda pantalla en modo **Extender** (Windows + P → Extender).
2. Pulsa **📺 Abrir proyección**. La primera vez el navegador puede pedir permiso para
   «administrar ventanas en todas las pantallas»: acéptalo y la ventana se abrirá en la otra pantalla.
   Si no, arrástrala tú.
3. Haz **doble clic** en la ventana de proyección (o pulsa **F**) para pantalla completa.

El video sigue al crossfader (o elige *Solo A* / *Solo B*). También puedes poner la pantalla en negro,
un texto fijo (tu nombre de DJ) y mostrar el nombre de cada canción al entrar.
Para Zoom, Meet u OBS, comparte la ventana de proyección. **El sonido sale de la consola**, no de la proyección.

## Atajos de teclado

| Tecla | Acción |
|---|---|
| Q / W | Play-pausa / CUE de la bandeja A |
| P / O | Play-pausa / CUE de la bandeja B |
| 1–4 / 7–0 | Hot cues de A / B (Mayús + número: borrar) |
| ← → / ↓ | Mover / centrar el crossfader |
| F | Auto-fade |
| N | Pantalla negra |

## Limitaciones (por el reproductor de YouTube)

- Se reproduce con el reproductor oficial, así que YouTube puede poner **anuncios**. La app no los
  bloquea, pero evita que lleguen a la pista: la canción que preparas en la otra bandeja pasa su anuncio
  en silencio antes de quedar lista; AutoMix no cruza a una bandeja que siga en un anuncio; y en la
  proyección se oculta cualquier video que esté en un anuncio. Para no tener anuncios de ningún tipo,
  usa **YouTube Premium** con tu cuenta abierta en youtube.com en el mismo navegador.
- Algunos videos **no permiten** reproducirse fuera de YouTube (salen marcados como *NO DISPONIBLE*).
- No hay ecualizador, filtros ni forma de onda: YouTube no deja procesar su audio.
- La velocidad solo va en pasos (0.25×, 0.5×, 0.75×, 1×, 1.25×…); los loops cortos pueden sonar con un pequeño corte.
- Las listas se guardan en el navegador. Usa *Exportar* para hacer copia o pasarlas a otro PC.
