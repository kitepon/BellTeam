#define MODULE_NAME "auth-mediation"
#define MODULE_ENTRY "auth-mediation-entry"
#define MODULE_ERROR "AUTH_MEDIATION_ADMISSION_FAILED"
#define MODULE_STATE_ENV "AUTH_MEDIATION_STATE"
/* shortcut: first administrators (Sakura, Rai) are fixed in the image, change = body train; upgrade when the Owner wants a runtime list. */
#define MODULE_FIXED_ENV_NAME "AUTH_MEDIATION_ADMINS"
#define MODULE_FIXED_ENV_VALUE "bot-a5022c62,bot-24c81542"
#include "module-start.c"
