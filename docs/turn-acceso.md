# Modelo de acceso a TURN

> Quién puede pedir credenciales TURN a un proxy, hoy y a futuro. El TURN
> (relay de WebRTC) lo **paga el operador del proxy** con su cuenta de
> Cloudflare, así que la pregunta no es "¿es una app de Dotrino?" sino **"¿a
> quién quiere subsidiar el operador con su ancho de banda?"**.

## Por qué no hay un bit de "pertenece al ecosistema"

Dotrino es un ecosistema **abierto y descentralizado**: cada usuario es su propia
autoridad (su propio vault/identidad). Las apps las usan personas con
**identidades soberanas propias**, no con el vault de Dotrino. Por eso el proxy,
cuando llega una petición de `turn-credentials`, no puede distinguir por identidad
a un usuario legítimo de un atacante: ninguno está firmado por una autoridad
común, porque **esa autoridad común no existe por diseño**.

Corolario importante: **exigir "un cert del vault" NO sirve como gate.** Como
cualquiera puede correr su propio vault y auto-firmarse el cert que quiera, un
cert solo prueba "esta llave fue delegada por *esa* maestra" — y si la maestra la
elige el atacante, no prueba nada. Es `identify` autofirmado con un paso más.

El criterio correcto no es *pertenencia* (binaria, verificable) sino **confianza
transitiva desde una raíz que elige el operador**.

## Modelo ACTUAL (implementado)

El gate es `identify` (sobre firmado + bind pubkey↔token) **más techos de
gasto**. Honestamente: `identify` es autofirmado, así que hoy **no restringe la
pertenencia** — cualquiera que hable el protocolo del proxy obtiene credenciales.
Lo que sí está acotado es el **costo del abuso**:

- **TTL corto** (`TURN_TTL_SECONDS`, def 600 s): una credencial no es un relay
  permanente.
- **Cuota por pubkey/hora** (`TURN_MAX_PER_HOUR`, def 12).
- **Techo GLOBAL de emisiones/hora** (`TURN_GLOBAL_MAX_PER_HOUR`, def 2000):
  acota el gasto contra Cloudflare **aunque el atacante rote pubkeys** (cada una
  con su cuota por-pubkey intacta).
- **Tope de memoria** (`TURN_MAX_TRACKED`) + barrido periódico: las pubkeys
  autofirmadas no hacen crecer el proceso sin límite.
- **Timeout + tope de concurrencia** del fetch a Cloudflare.

Esto basta mientras no haya tráfico de abuso real. No pretende ser el gate de
pertenencia.

## Modelo PREVISTO (roadmap — NO implementado aún)

El acceso a TURN se limita por **reputación anclada en la red de confianza del
operador**: *"TURN lo usa la gente en la que el operador confía"*.

La pieza técnica **ya existe**: `aggregateTrust` de `@dotrino/reputation` se ancla
en un pubkey raíz (`myPubkey`, credibilidad 1) y solo pondera avales que tengan un
**camino de confianza desde esa raíz** (transitivo hasta `maxDepth`, con
decaimiento). Es **anti-sybil por diseño**: mil pubkeys nuevas sin aval → trust 0.

Gate previsto:

```
aggregateTrust(pubkeyDelCliente, { myPubkey: raízDelOperador }) ≥ umbral
```

- Una identidad sybil recién creada queda en 0 → sin TURN (o solo el mínimo).
- Quien está en la red de confianza del operador (directa o transitivamente) pasa.
- El veredicto de trust se **cachea por pubkey** en el proxy (el trust cambia
  lento): NO se consulta `reputation.dotrino.com` en cada petición.

### Transición suave (no un muro)

Activarlo de golpe dejaría fuera a usuarios nuevos legítimos que aún no tienen
avales. La política prevista es **mínimo austero para todos + cuota ampliada por
nivel de confianza**: el sybil masivo se queda en el piso, pero nadie legítimo se
queda sin servicio mientras la red de confianza madura. Los techos de gasto del
modelo actual quedan como capa previa.

### Estado

El motor (`aggregateTrust`) está listo. **Falta poblar la web-of-trust** (proceso
social/temporal, no código: el operador y la gente que avala emiten atestaciones
firmadas y la confianza se propaga) y **cablear el proxy** (consulta de reputación
anclada en la raíz + cache + umbral configurable). No urge sin tráfico.

## Federación: cada operador ancla en SU raíz

Este modelo es **el mismo para cualquier operador**, no un privilegio de Dotrino.
Un tercero que levanta su proxy con su propia cuenta de Cloudflare ancla
`aggregateTrust` en **su** identidad → sirve TURN a **la gente en la que él
confía**. Misma máquina, misma lógica, distinta raíz. El proxy oficial de Dotrino
ancla en la identidad de Dotrino; el tuyo, en la tuya. Eso es descentralización
real: nadie depende de que Dotrino lo "admita".

Ver también [`FEDERATION.md`](../FEDERATION.md) (federación del transporte).
