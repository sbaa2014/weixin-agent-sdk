/* Compatibility shim for the system Chromium build's libopenmpt dependency. */
int mpg123_param2(void *mh, int type, long value, double fvalue) {
    (void)mh;
    (void)type;
    (void)value;
    (void)fvalue;
    return 0;
}
