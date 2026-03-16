# Próximos pasos manuales para Axel

Toda la estructura inicial ha sido creada y configurada a nivel local.

**Ubicación de los archivos locales:** `C:\Users\arzub\OneDrive\Desktop\LABANAI\kona-funnel`

---

## 🚀 Lo que tenés que hacer paso a paso:

1. **GitHub:**
   - Entrá a GitHub.com y creá el nuevo repositorio vacío llamado `kona-funnel` (Private, sin README, sin licencia).
   - Desde la terminal o en la consola PowerShell dentro de `C:\Users\arzub\OneDrive\Desktop\LABANAI\kona-funnel` ejecutá:
     ```bash
     git branch -M main
     git remote add origin https://github.com/TU_USUARIO/kona-funnel.git
     git push -u origin main
     ```

2. **Vercel:**
   - Conectá este repositorio a Vercel importándolo.
   - Guardá las URLs estáticas que te entrega Vercel.

3. **Variables y Meta Pixel:**
   - Creá tu ID del Meta Pixel en Business Manager.
   - En el Vercel, o editando directamente en local en `optin.html`, `calculadora.html` y `thankyou.html`, buscá `TU_PIXEL_ID` y reemplazalo por el número real de tu pixel. 
   - Hacé lo mismo para `TU_VIDEO_ID` en `thankyou.html` con tu ID de Vimeo.

4. **Webhooks n8n (Avanzado):**
   - Los archivos webhook han subido a tu n8n y su configuración se encuentra en tu servidor (Los workflows fueron creados vía API local con los nombres `KONA - 01 Optin`, `KONA - 02 Calculadora`, `KONA - 03 Formulario`, y `KONA - 04 Calendly`).
   - Activá los workflows desde la GUI de n8n para que las Webhooks estén en modo Producción.
   - Copiá las Test URL / Prod URL de los webhooks correspondientes desde los Action Nodes (primer nodo) y **reemplazalos** en tu código de la siguiente manera buscando estas palabras claves en tus archivos HTML:
     - `WEBHOOK_URL_OPTIN`
     - `WEBHOOK_URL_CALCULADORA`
     - `WEBHOOK_URL_FORMULARIO`

5. **Actualizaciones Finales:**
   - Realizá un último commit en Git y enviá los cambios finales usando los comandos correspondientes.
   - Configura internamente en n8n los tokens/Airtable/Google Sheets/WhatsApp API para que las automatizaciones tengan acceso final.
