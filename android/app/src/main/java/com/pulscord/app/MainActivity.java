package com.pulscord.app;

import com.getcapacitor.BridgeActivity;
import android.Manifest;
import android.os.Bundle;
import android.view.Window;
import android.view.WindowManager;

public class MainActivity extends BridgeActivity {
	private static final int MEDIA_PERMISSION_REQUEST = 7001;

	@Override
	public void onCreate(Bundle savedInstanceState) {
		super.onCreate(savedInstanceState);
		Window window = getWindow();
		window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
		window.setStatusBarColor(android.graphics.Color.rgb(23, 33, 43));
		window.setNavigationBarColor(android.graphics.Color.rgb(23, 33, 43));
		if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
			requestPermissions(new String[] {
				Manifest.permission.RECORD_AUDIO,
				Manifest.permission.CAMERA
			}, MEDIA_PERMISSION_REQUEST);
		}
	}

}
