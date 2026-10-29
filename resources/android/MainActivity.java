package com.umit.mesaj;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Uygulamanın kendi eklentisi: galeriye kaydetme ve zil sesli bildirim
        registerPlugin(SuhbetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
