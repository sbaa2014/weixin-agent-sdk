/* Compatibility shim for the system Chromium build's libopenmpt dependency. */
int mpg123_param2(void *mh, int type, long value, double fvalue) {
    (void)mh; (void)type; (void)value; (void)fvalue;
    return 0;
}
#define SHIM(name) long name() { return 0; }
SHIM(mpg123_format2)
SHIM(mpg123_new)
SHIM(mpg123_open_handle)
SHIM(mpg123_read)
SHIM(mpg123_format_none)
SHIM(mpg123_encsize)
SHIM(mpg123_getformat)
SHIM(mpg123_length64)
SHIM(mpg123_exit)
SHIM(mpg123_id3)
SHIM(mpg123_delete)
SHIM(mpg123_info2)
SHIM(mpg123_init)
SHIM(mpg123_outblock)
SHIM(mpg123_reader64)
SHIM(mpg123_scan)
