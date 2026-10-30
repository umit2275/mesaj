package com.umit.mesaj;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Uygulamanın kendi eklentisi: galeriye kaydetme, bildirim, zil ve titreşim
        registerPlugin(SuhbetPlugin.class);
        super.onCreate(savedInstanceState);

        // Geri tuşu: uygulama içinde bir önceki ekrana dön (büyük fotoğraf, sohbet → liste);
        // gidilecek ekran kalmadıysa uygulamadan çık.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() != null ? getBridge().getWebView() : null;
                if (web != null && web.canGoBack()) {
                    web.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });
    }
}
