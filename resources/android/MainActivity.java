package com.umit.mesaj;

import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Uygulamanın kendi eklentisi: galeriye kaydetme, bildirim, zil ve titreşim
        registerPlugin(SuhbetPlugin.class);
        super.onCreate(savedInstanceState);

        fitWebViewToScreen();

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

    /**
     * Her Android sürümünde aynı davranış: uygulama durum çubuğu ile alttaki
     * gezinme tuşlarının ARASINA sığdırılır; klavye açılınca da klavyenin üstünde
     * biter. (Android 15 uygulamayı ekranın altına kadar uzatıp klavyede yeniden
     * boyutlandırmadığı için mesaj kutusu tuşların/klavyenin arkasında kalıyordu.)
     */
    private void fitWebViewToScreen() {
        WebView web = getBridge() != null ? getBridge().getWebView() : null;
        if (web == null) return;

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().getDecorView().setBackgroundColor(Color.parseColor("#008069"));
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        WindowInsetsControllerCompat ctl = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        ctl.setAppearanceLightStatusBars(false);
        ctl.setAppearanceLightNavigationBars(false);

        ViewCompat.setOnApplyWindowInsetsListener(web, (v, wi) -> {
            Insets bars = wi.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = wi.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams mlp = (ViewGroup.MarginLayoutParams) v.getLayoutParams();
            mlp.leftMargin = bars.left;
            mlp.rightMargin = bars.right;
            mlp.topMargin = bars.top;
            mlp.bottomMargin = Math.max(bars.bottom, ime.bottom);
            v.setLayoutParams(mlp);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(web);
    }
}
