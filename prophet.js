const nj = require("numjs");
const DF = require("pandas-js").DataFrame;
const linspace = require("linspace");

class prophet_js {

    /*
    Parameters
    ----------
    growth: String 'linear' or 'logistic' to specify a linear or logistic trend.
    changepoints: List of dates at which to include potential changepoints. If
        not specified, potential changepoints are selected automatically.
    n_changepoints: Number of potential changepoints to include. Not used
        if input `changepoints` is supplied. If `changepoints` is not supplied,
        then n_changepoints potential changepoints are selected uniformly from
        the first 80 percent of the history.
    yearly_seasonality: Fit yearly seasonality.
        Can be 'auto', True, False, or a number of Fourier terms to generate.
    weekly_seasonality: Fit weekly seasonality.
        Can be 'auto', True, False, or a number of Fourier terms to generate.
    daily_seasonality: Fit daily seasonality.
        Can be 'auto', True, False, or a number of Fourier terms to generate.
    holidays: pd.DataFrame with columns holiday (string) and ds (date type)
        and optionally columns lower_window and upper_window which specify a
        prophet_js.range of days around the date to be included as holidays.
        lower_window=-2 will include 2 days prior to the date as holidays. Also
        optionally can have a column prior_scale specifying the prior scale for
        that holiday.
    seasonality_prior_scale: Parameter modulating the strength of the
        seasonality model. Larger values allow the model to fit larger seasonal
        fluctuations, smaller values dampen the seasonality. Can be specified
        for individual seasonalities using add_seasonality.
    holidays_prior_scale: Parameter modulating the strength of the holiday
        components model, unless overridden in the holidays input.
    changepoint_prior_scale: Parameter modulating the flexibility of the
        automatic changepoint selection. Large values will allow many
        changepoints, small values will allow few changepoints.
    mcmc_samples: Integer, if greater than 0, will do full Bayesian inference
        with the specified number of MCMC samples. If 0, will do MAP
        estimation.
    interval_width: Float, width of the uncertainty intervals provided
        for the forecast. If mcmc_samples=0, this will be only the uncertainty
        in the trend using the MAP estimate of the extrapolated generative
        model. If mcmc.samples>0, this will be integrated over all model
        parameters, which will include uncertainty in seasonality.
    uncertainty_samples: Number of simulated draws used to estimate
        uncertainty intervals.
        */
    constructor(
    //学習方法、変化点など学習、予測を行うためのパラメータ初期化
        growth = "linear",
        changepoints = null,
        n_changepoints = 25,
        yearly_seasonality="auto",
        weekly_seasonality="auto",
        dalily_seasonality="auto",
        holidays = null,
        seasonality_prior_scale = 10.0,
        holidays_prior_scale = 10.0,
        changepoint_prior_scale = 0.05,
        mcmc_samples = 0, 
        interval_width = 0.80,
        uncertainty_samples = 1000
    ){

        this.growth = growth;
        this.changepoints = changepoints;       
        if (this.changepoints != null){
            this.n_changepoints = changepoints.length;
            this.specified_changepoints = true;
        }
        else{
            this.n_changepoints = n_changepoints;
            this.specified_changepoints = false;
        }

        this.yearly_seasonality=yearly_seasonality;
        this.weekly_seasonality=weekly_seasonality;
        this.dalily_seasonality=dalily_seasonality;

        //休日データにdsとholidayが入っているかチェック
        if(holidays != null){ 
            if("ds" in holidays == false && "holiday" in holidays == false) 
            console.log("holidays must be a DataFrame with 'ds' and 'holiday' columns.");
            holidays["ds"] = holidays;
        }

        this.holidays = holidays;

        this.seasonality_prior_scale = seasonality_prior_scale;
        this.holidays_prior_scale = holidays_prior_scale;
        this.changepoint_prior_scale = changepoint_prior_scale;
        this.mcmc_samples = mcmc_samples;
        this.interval_width = interval_width;
        this.uncertainty_samples = uncertainty_samples;

        //Set during fitting
        this.start = null;
        this.y_scale = null;
        this.logistic_floor = false;
        this.t_scale = null;
        this.changepoints_t = null;
        this.seasonalities = {};
        this.extra_regressors = {};
        this.stan_fit = null;
        this.params = {};
        this.history = null;
        this.history_dates = null;
        this.validate_inputs();
    }

    check_df_log(masseage,df){
        console.log(masseage);
        for(let i = 0; i< 10; i++){
            console.log(i+"   "+df[i]);
        }
        console.log("・・・");
        for(let i = this.shape0(df) - 11; i < this.shape0(df); i++){
            console.log(i+"   "+df[i]);
        }
    }

    shape0(df){
        let len = Object.keys(df).length;
        return len;
    }

    shape1(df){
        let len = df[0].length;
        return len;
    }

    Date_max(date){
        let last = date[0].ds;
        for(let i = 0; i< this.shape0(date)-1; i++){/*dsの最大値を求める*/
            if(last.getTime() < date[i+1].ds.getTime()){
                last = date[i+1].ds;
                    console.log("date_max");
                    console.log(last);
            }
        }
        return last;
    }
    Date_min(date){
        let first = date[0].ds;
        for(let i = 0; i< this.shape0(date)-1; i++){/*dsの最小値を求める*/
            if(first.getTime() > date[i+1].ds.getTime()){
                first = date[i+1].ds;
                console.log("date_min");
                console.log(first);
            }
        }
        return first;
    }
    /*
    c_array_push(array,pra){
        let c_array = [];

        c_array.length = 0;
        for(let a_c_cnt in array){
            c_array.push(array[a_c_cnt].pra); //チェック用配列にyの値を入れていく
        }
        return c_array;
    }*/

    /*既存のjsonオブジェクトに新しいパラメータを挿入します*/ 
    json_add(df,injson,mode){
        if(mode == 0){
            let len = this.shape0(df);
            for(let i=0; i < len; i++){
                df[i] = Object.assign(df[i],injson);
            }
            return df;
        }
        if(mode == 1){
            let len = this.shape0(df);
            for(let i=0; i < len; i++){
                df[i] = Object.assign(df[i],injson[i]);
            }
            return df;
        }
    }

    range(num){
        let s_array = new Array(num);
        for(let i = 0; i < num; i++){
            s_array[i] = i;
        }
        return s_array;
    }


    average(arr){
        var sum = 0;
        arr.forEach(function(elm) {
            sum += elm;
            });
            return sum/arr.length;
        }
    

    formatDate(date){/*date型を文字列型に直す*/
        const yyyy = new String(date.getFullYear());
        const mm = new String(date.getMonth() + 1);
        const dd = new String(date.getDate());
        return `${yyyy}/${mm}/${dd}`;
    }

    getDiff(date1, date2) {/*data型の2つの日付の日数を求める*/
        let msDiff = date2.getTime() - date1.getTime();
        let daysDiff = Math.floor(msDiff / (1000 * 60 * 60 *24));
        return ++daysDiff;
    }

    validate_inputs(){
        //Validates the inputs to Prophet.
        if(this.growth != "linear" && this.growth != "logistic" ){
            console.log("Parameter 'growth' should be 'linear' or 'logistic'.");
        }
        if(this.holidays != null){
            let has_lower = "lower_window" in this.holidays;
            let has_upper = "upper_window" in this.holidays;
            if(has_lower + has_upper ==1){
                console.log("Holidays must have both lower_window and upper_window, or neither");
            }
            //if(has_lower)???
        }
    }

    validate_column_name(name,check_holidays=true,check_seasonalities=true,check_regressors=true){
       /*
        Validates the name of a seasonality, holiday, or regressor
        Parameters
        --------------------------------------------------------------
        name: string
        check_holidays: bool check if name already used for holiday
        check_seasonalities: bool check if name already used for seasonality
        check_regressors: bool check if name already used for regressor
        ---------------------------------------------------------------
       */ 
        
        if("_delim_" in name){
            console.log("name cannot contain '_delin_'");
        }

        let reserved_names =["trend", "seasonal", "seasonalities", "daily", "weekly", "yearly",
        "holidays", "zeros", "extra_regressors", "yhat"];
        const extend_reserved=["ds", "y", "cap", "floor", "y_scaled", "cap_scaled"];

        let nr_l = [];
        let nr_u = [];

        for(let n = 0; n <= reserved_names.length; n++){
            nr_l.push(reserved_names[n]+"_lower");
        }
        for(let n = 0; n <= reserved_names.length; n++){
            nr_u.push(reserved_names[n]+"_upper");
        }
        //配列reserved_namesに各要素追加
        Array.prototype.push.apply(reserved_names,nr_l);
        Array.prototype.push.apply(reserved_names,nr_u);
        Array.prototype.push.apply(reserved_names,extend_reserved);

        //重複チェック
        if(name in reserved_names){
            console.log("Name"+name+"is reserved.");
        }

        if(check_holidays && this.holidays != null && name in this.holidays["holiday"]/*???*/){
           console.log("Name"+name+"already used for a holiday."); 
        }

        if(check_seasonalities && name in this.seasonalities){
            console.log("Name"+name+"already used a seasonality.");
        }

        if(check_regressors && name in this.extra_regressors){
            console.log("Name"+name+"already used for an added regressor.");
        }
    }

    

    setup_dataframe(df,initialize_scales = false){
        /*
        Prepare dataframe for fitting or predicting.
        
        Adds a time index and scales y. Creates auxiliary columns 't', 't_ix',
        'y_scaled', and 'cap_scaled'. These columns are used during both fitting and predicting.
        
        Parameters
        ----------
        df: pd.DataFrame with columns ds, y, and cap if logistic growth. Any specified additional regressors must also be present.
            initialize_scales: Boolean set scaling factors in this from df.
        
        Returns
        -------
        pd.DataFrame prepared for fitting or predicting.
        */
        this.check_df_log("df:setup_dataframe",df);
        let df_ds = [];//チェック用配列
        let df_y = [];
        let df_floor =[];
        let df_y_scaled = [];
        let cal_work = [];

        function sort_by(field, reverse, primer){
            reverse = (reverse) ? -1:1;
            return function(a,b)
            {
                a = a[field];
                b = b[field];
                if (typeof(primer) != "undefined")
                {
                    a = primer(a);
                    b = primer(b);
                }
                if (a<b) return reverse * -1;
                if (a>b) return reverse * 1;
                return 0;
            };
        }
        /*
        function array_inf_check(){
            return(isFinite(c_array.values));
        }
    
        function array_NaN_check(){
            return(isNaN(c_array.values));
        }*/

        
        /*
        let array_judge = c_array.every(isFinite(c_array.values)); 
        if(array_judge != true){
            console.log("Found infinity in column y.");
        }
        //pd.to_datatime(df['ds'])
        c_array.length = 0;
        console.log(c_array);//チェック用配列を空にする
        */

        /*
        for(let a_c_cnt in df){
            c_array.push(df[a_c_cnt].ds); //チェック用配列にyの値を入れていく
        }
        if(c_array.every(array_NaN_check()) == true){
            console.log("Found NaN in column ds.");
        }
        c_array.length = 0;//チェック用配列を空にする
        console.log(c_array);
        */
        for(let i = 0; i<this.shape0(df); i++){
            df_ds[i] = {"ds":new Date(df[i].ds)}; 
        }
        this.check_df_log("df_ds:319",df_ds);
        df = this.json_add(df,df_ds,1);
        this.check_df_log("df:323",df);

        for(let i = 0; i<this.shape0(df); i++){
            if(df[i].ds == null)
             console.log("Found NaN in column ds.");
        }
        for(let name in this.extra_regressors){
            if(name in df != true)
            {
                console.log("Regressor "+name+" missing from dataframe")
            }
        }
        //pandas-jsはdfの場合ソート不可(seriesなら可)
        df = df.sort(sort_by("ds",false,parseFloat)); 

        //df.reset_index({drop: true});

        this.initialize_scales(initialize_scales,df);

        if(this.logistic_floor){
            if("floor" in df != true){
                console.log("Expected column 'floor'.");
            }
        }
        else{
            let flo = {};
            flo.floor = 0;
            df = this.json_add(df,flo,0); 
            this.check_df_log("df:352",df);
        }
        let df_t = [];
        for(let i = 0; i < df_ds.length; i++){
            df_t[i] = {"t":((df_ds[i].ds - this.start)/this.t_scale)};
        }
        this.check_df_log("df_t:359",df_t);
        df = this.json_add(df,df_t,1);
        
        if("y" in df){
            for(let a_c_cnt in df){
                df_y.push(df[a_c_cnt].y); 
                df_floor.push(df[a_c_cnt].floor);
            }
            for(let i = 0; i < df_y.length; i++){
                df_y_scaled[i] = {"y_scaled":((df_y[i] - df_floor[i])/this.t_scale)};
            }
            df = this.json_add(df,df_y_scaled,1);
        }
        //this.check_df_log("y_scaled",this.y_scaleed);
        console.log("y_scaled");
        console.log(df_y_scaled);
        /*
        for name, props in this.extra_regressors
            df[name] = pd.to_numeric(df[name])
            df[name] = ((df[name] - props['mu']) / props['std'])
            if df[name].isnull().any():
                raise ValueError('Found NaN in column ' + name)
        */
        this.check_df_log("df:setup_dataframe_last",df);
        return df;
             
    }

    initialize_scales(initialize_scales,df){
        /*
        Initialize model scales.

        Sets model scaling factors using df.

        Parameters
        ----------
        initialize_scales: Boolean set the scales or not.
        df: pd.DataFrame for setting scales.
        */
        let df_ds = [];
        let df_y = [];
        let df_name = [];
        let floor;

        if(initialize_scales != true){
            return;
        }
        if(this.growth == "logistic" && "floor" in df)
        {
            this.logistic_floor = true;
            floor = df["floor"];
        }
        else
        {
            floor = 0;
        }
        for(let i = 0; i < df.length; i++){
            df_y[i] = df[i].y;
        }
        for(let i = 0; i < df.length; i++){
            this.y_scale = {"y_scale":Math.max(Math.abs((df_y[i] - floor)))};
        }

        if(this.y_scale == 0){
            this.y_scale = 1;
        }

        for(let i = 0; i < df.length; i++){
            df_ds[i] = {"ds":new Date(df[i].ds)};
        }
        this.check_df_log("df_ds::init",df_ds);
        let d_min = this.Date_min(df_ds);
        console.log("df_ds::min");
        console.log(d_min);
        this.start = Math.min(df_ds);
        this.t_scale = (Math.max(df_ds) - this.start);
        /*
        for name, props in self.extra_regressors.items():
        standardize = props['standardize']
        if standardize == 'auto':
            if set(df[name].unique()) == set([1, 0]):
                # Don't standardize binary variables.
                standardize = False
            else:
                standardize = True
        if standardize:
            mu = df[name].mean()
            std = df[name].std()
            if std == 0:
                std = mu
            self.extra_regressors[name]['mu'] = mu
            self.extra_regressors[name]['std'] = std
        */
    }
    set_changepoints(){
        /*
        ここではdfではなくhistory
        Set changepoints

        Sets m$changepoints to the dates of changepoints. Either:
        1) The changepoints were passed in explicitly.
            A) They are empty.
            B) They are not empty, and need validation.
        2) We are generating a grid of them.
        3) The user prefers no changepoints be used.
        */
        
        let too_low;
        let too_high;
        const dummy_cp = [];
        let c_array = [];
        let hist_size;

        if(this.changepoints != null){
            if(this.changepoints.length == 0);
            else{
                for(let a_c_cnt in history){
                    c_array.push(history[a_c_cnt].ds); //チェック用配列にdsの値を入れていく
                }
                too_low = Math.min(this.changepoints) < Math.min(c_array);
                too_low = Math.max(this.changepoints) < Math.max(c_array);
                if(too_low == true || too_high == true){
                    console.log("Changepoints must fall within training data.");
                }
            }
        }
        else{
        // Place potential changepoints evenly through first 80% of history 
        let count = Object.keys(history).length;
        hist_size = Math.floor(count * 0.8);
        }
        if(this.n_changepoints +1 > hist_size){
            this.n_changepoints = hist_size - 1;
            console("n_changepoints greater than number of observations.\nUsing"+this.n_changepoints+ ".");
        }
        
        if(this.n_changepoints > 0){
            let cp_indexes = (linspace(0,hist_size,this.n_changepoints + 1));
            for(let i = 0; i<cp_indexes.length; i++){
                cp_indexes[i] = parseInt(Math.round(cp_indexes[i]));
            }
            this.changepoints = (
                this.history.iloc[cp_indexes]["ds"].tail(-1)
            );//???
        }
        else{
            //set empty changepoints
            this.changepoints = [];
        }

        if(this.changepoints.length > 0){
            let change_a = [];
            change_a = (this.changepoints - this.start) / this.t_scale;
            this.changepoints_t = change_a.sort(function(a,b){
                if( a < b ) return -1;
                if( a > b ) return 1;
                return 0;
            });
        }
        else{
            this.changepoints_t = dummy_cp[0];//dummy changepoint 
        }

    }

    get_changepoint_matrix(){
        //Gets changepoint matrix for history dataframe.
        let count = prophet_js.shape0(history);
        let A = nj.zeros(count,this.changepoints_t.length);
        function enumrate_t(df){
            let idx = [];
            let t = [];
            let len = prophet_js.shape0(df);
            for(let i = 0; i < len; i++){
                idx[i] = i;
                t[i] = df[i].t;
            }
            return [idx,t];
        }

        let result = enumrate_t(this.changepoints_t);
        let idx = result[0];
        let t = result[1];

        if(this.history.t >= A[t][idx]){
            A[t][idx] = 1;
        }
        
        //console.log("A");
        //console.log(A);
        return A;
    }


    /*fourier_series*/
    fourier_series(dates,period,series_order){
    /*
    """Provides Fourier series components with the specified frequency
        and order.

        Parameters
        ----------
        dates: pd.Series containing timestamps.
        period: Number of days of the period.
        series_order: Number of components.

        Returns
        -------
        Matrix with seasonality features.
        """
        # convert to days since epoch
    */ 
        
        let t = [];
        let fun = [];
        let d2 = new Date(1970,0,1);
        let d_dif = [];
        console.log("series_order");
        console.log(series_order);
        console.log("piriod");
        console.log(period);
        this.check_df_log("dates",dates); 

        for(let i = 0; i<dates.length; i++){
            d_dif[i] = parseFloat((this.getDiff(d2,dates[i].ds) - 1) * 86400);
        }
        this.check_df_log("d_dif",d_dif);

        for(let i = 0; i<dates.length; i++){
            t[i] = d_dif[i]/(3600*24);
        }

        this.check_df_log("t",t);
        let fun2 = [];

        for(let cont in this.range(series_order.fourier_order)){
            for(let i = 0; i<t.length; i++){
                fun[i] = (2.0*(cont+1)*Math.PI*t[i]/period.period);
            }
            fun2[cont] = fun;
        }
        x = Math.sin(fun2)
        y = Math.cos(fun2)
        [x y]
        this.check_df_log("fun",fun);
        this.check_df_log("fun2",fun2);
        return fun2;
    }
    /* make_seasonality_features*/ 
    make_seasonality_features(dates,period,series_order,prefix){
    /*Data frame with seasonality features.

        Parameters
        ----------
        cls: Prophet class.
        dates: pd.Series containing timestamps.
        period: Number of days of the period.
        series_order: Number of components.
        prefix: Column name prefix.

        Returns
        -------
        pd.DataFrame with seasonality features.*/

        let features = this.fourier_series(dates,period,series_order); 
        this.check_df_log("featurs",features);
        let key = [];
        for(let i in this.range(this.shape1(features))){
            let num = i+1;
            key[i] = prefix+"_delim_"+ num;
            features[i] = {key:features[i]} ;
        }
        this.check_df_log("features",features);
        return features;
    }
    /*make_holiday_features（不要）*/ 

    /*add_regressor*/ 
    add_regressor(name,prior_scale = null, standardize="auto"){
    /*
    Add an additional regressor to be used for fitting and predicting.

        The dataframe passed to `fit` and `predict` will have a column with the
        specified name to be used as a regressor. When standardize='auto', the
        regressor will be standardized unless it is binary. The regression
        coefficient is given a prior with the specified scale parameter.
        Decreasing the prior scale will add additional regularization. If no
        prior scale is provided, this.holidays_prior_scale will be used.

        Parameters
        ----------
        name: string name of the regressor.
        prior_scale: optional float scale for the normal prior. If not
            provided, this.holidays_prior_scale will be used.
        standardize: optional, specify whether this regressor will be
            standardized prior to fitting. Can be 'auto' (standardize if not
            binary), True, or False.

        Returns
        -------
        The prophet object.*/
        
        let check_regressors =false;
        if(this.history != null){
            console.log("Regressors must be added prior to model fitting.");
        }
        this.validate_column_name(name,check_regressors);
        if(prior_scale != null){
            prior_scale = Math.parseFloat(this.holidays_prior_scale);
        }
        if((prior_scale > 0) == false){
            console.log("error!:prior_scale > 0 になってません");
        }
        this.extra_regressors[name] = {
            "prior_scale":prior_scale,
            "standardize":standardize,
            "mu": 0.,
            "std":1.,
        };
        return this;
    }
    /*add_seasonality*/ 
    add_seasonality(name,period,fourier_order,prior_scale=null){
    /*Add a seasonal component with specified period, number of Fourier
        components, and prior scale.

        Increasing the number of Fourier components allows the seasonality to
        change more quickly (at risk of overfitting). Default values for yearly
        and weekly seasonalities are 10 and 3 respectively.

        Increasing prior scale will allow this seasonality component more
        flexibility, decreasing will dampen it. If not provided, will use the
        seasonality_prior_scale provided on Prophet initialization (defaults
        to 10).

        Parameters
        ----------
        name: string name of the seasonality component.
        period: float number of days in one period.
        fourier_order: int number of Fourier components to use.
        prior_scale: float prior scale for this component.

        Returns
        -------
        The prophet object.*/
        let ps;
    

        if(this.history != null){
            console.log("Seasonality must be added prior to model fitting.");
        } 
        if(name in ["daily","weekly","yearly"] == false){
            console.log("'daily', 'weekly', 'yearly'のどれかが入ってません");
            this.validate_column_name(name,false);
        }
        if(prior_scale != null){
            ps = this.seasonality_prior_scale;
        }
        else{
            ps = Math.parseFloat(prior_scale);
        }
        if(ps <= 0){
            console.log("add_seasonality::Prior scale must be > 0");
        }
        this.seasonalities[name] ={
            "period": period,
            "fourier_order": fourier_order,
            "prior_scale": ps,
        };
        return this;
    }
    /*make_all_seasonality_features*/ 
    make_all_seasonality_features(df){
    /*Dataframe with seasonality features.

        Includes seasonality features, holiday features, and added regressors.

        Parameters
        ----------
        df: pd.DataFrame with dates for computing seasonality features and any
            added regressors.

        Returns
        -------
        pd.DataFrame with regression features.
        list of prior scales for each column of the features dataframe. */
        let features;
        let seasonal_features = [];
        let prior_scales = [];
        let props;
        let df_ds=[];
        let props_priod=[];
        let props_f_order=[];
        let props_p_scale=[];
        let name;
        //df["ds"]
        for(let i=0; i < this.shape0(df); i++){
            df_ds[i] = {"ds":(df[i].ds)};
        }
        
        console.log("this.seasonalities");
        console.log(this.seasonalities);

        if("yeary" in this.seasonalities){
            console.log("yeary found");
            name = "yeary";
            props_priod = {"period":(this.seasonalities.yeary.prior_scale)};        
            props_f_order = {"fourier_order":(this.seasonalities.yeary.fourier_order)};            
            props_p_scale = {"prior_scale":(this.seasonalities.yeary.prior_scale)};
            features = this.make_seasonality_features(
                df_ds,
                props_priod,
                props_f_order,
                name
            );
            this.check_df_log("featurs",features);
            seasonal_features.push(features);
            for(let i = 0; i<props_p_scale.length; i++){
                props_p_scale[i] = props_p_scale[i] * this.shape1(features);
            }
            prior_scales.push(props_p_scale);
        }

        if("weekly" in this.seasonalities){
            console.log("weekly found");
            name = "weekly";            
            props_priod = {"period":(this.seasonalities.weekly.prior_scale)};            
            props_f_order = {"fourier_order":(this.seasonalities.weekly.fourier_order)};            
            props_p_scale = {"prior_scale":(this.seasonalities.weekly.prior_scale)};
            features = this.make_seasonality_features(
                df_ds,
                props_priod,
                props_f_order,
                name
            );
            this.check_df_log("featurs",features);
            seasonal_features.push(features);
            for(let i = 0; i<props_p_scale.length; i++){
                props_p_scale[i] = props_p_scale[i] * this.shape1(features);
            }
            prior_scales.push(props_p_scale);
        }

        if("daily" in this.seasonalities){
            console.log("daily found");
            name = "daily";
            props_priod = {"period":(this.seasonalities.daily.prior_scale)};
            props_f_order = {"fourier_order":(this.seasonalities.daily.fourier_order)};
            props_p_scale = {"prior_scale":(this.seasonalities.daily.prior_scale)};
            features = this.make_seasonality_features(
                df_ds,
                props_priod,
                props_f_order,
                name
            );
            this.check_df_log("featurs",features);
            seasonal_features.push(features);
            for(let i = 0; i<props_p_scale.length; i++){
                props_p_scale[i] = props_p_scale[i] * this.shape1(features);
            }
            prior_scales.push(props_p_scale);
        }

        for(props in this.seasonalities){
            features = this.make_seasonality_features(
                df_ds,
                props_priod,
                props_f_order,
                name
            );
            seasonal_features.push(features);
            prior_scales.push(this.shape1(features));
        }

        for(name in this.seasonalities){
            features = this.make_seasonality_features(
                df_ds,
                props_priod,
                props_f_order,
                name
            );
            seasonal_features.push(features);
            prior_scales.push(props_p_scale*prophet_js.shape1(features));
        }
        //Holiday features
        if(this.holidays != null){
            features,holiday_priors = this.make_holiday_features(df["ds"]);
            seasonal_features.push(features);
            prior_scales.push(holiday_priors);
        }

        //Additional regressors
        for(name in this.extra_regressors){
            seasonal_features.push(DF.DataFrame(df[name]));
            prior_scales.push(props_p_scale);
        }

        for(props in this.extra_regressors){
            seasonal_features.push(DF.DataFrame(df[name]));
            prior_scales.push(props_p_scale);
        }

        if(seasonal_features.length == 0){
            const df_z = new DataFrame({"zeros":nj.zeros(prophet_js.shape0(f_df))})
            seasonal_features.push(df_z);
            prior_scales.push(1.);
        }
        return concat(seasonal_features,axis=1),prior_scales;

    }

    /* parse_seasonality_args*/
    parse_seasonality_args(name,arg,auto_disable,default_order){
    /*Get number of fourier components for built-in seasonalities.

        Parameters
        ----------
        name: string name of the seasonality component.
        arg: 'auto', True, False, or number of fourier components as provided.
        auto_disable: bool if seasonality should be disabled when 'auto'.
        default_order: int default fourier order

        Returns
        -------
        Number of fourier components, or 0 for disabled.*/
        let fourier_order = 0;
        if(arg == "auto"){
            if(name in this.seasonalities){
                console.log("Found custom seasonality named "+name+",disabling built-in "+name+"seasonality.");
            }
            else if(auto_disable){
                console.log("Disabling"+name+"seasonality. Run prophet with"+name+"_seasonality=True to override this.");
            }
            else{
            fourier_order = default_order;
            }
        }
        else if(arg == true){
            fourier_order = default_order;
        }
        else if(arg == false){
            fourier_order = 0;
        }
        else{
            fourier_order = parseInt(arg);
        }
        return fourier_order;
    }
    /*set_auto_seasonalities*/
    set_auto_seasonalities(){
    /*Set seasonalities that were left on auto.

        Turns on yearly seasonality if there is >=2 years of history.
        Turns on weekly seasonality if there is >=2 weeks of history, and the
        spacing between dates in the history is <7 days.
        Turns on daily seasonality if there is >=2 days of history, and the
        spacing between dates in the history is <1 day.*/

        let date = [];//historyチェック用配列
        let yearly_disable;
        let weekly_disable;
        let daily_disable;
        for(let i=0; i<this.shape0(this.history); i++){
            date[i] = new Date(this.history[i].ds);
        }

        let first = date[0];

        for(let i = 0; i< this.shape0(this.history)-1; i++){/*dsの最小値を求める*/
            if(first.getTime() > date[i+1].getTime()){
                first = date[i+1];
                console.log(first);
            }
        }

        let last = date[0];
        for(let i = 0; i< this.shape0(this.history)-1; i++){/*dsの最大値を求める*/
            if(last.getTime() < date[i+1].getTime()){
                last = date[i+1];
                console.log(last);
            }
        }
        
        //let dt = last-first;
        //let min_dt = dt.iloc//???iloc,jsでどう実装?
        console.log("getdiff");
        console.log(this.getDiff(first,last));

        //Yearly seasonality
        if(this.getDiff(first,last) < 730){
            yearly_disable = true;
        } 
        let fourier_order = this.parse_seasonality_args(
            "yearly",this.yearly_seasonality,yearly_disable,10);
        if(fourier_order > 0){
            let a_obj = {
                "yeary":{
                  "period":365.25,
                  "fourier_order": fourier_order,
                  "prior_scale": this.seasonality_prior_scale,
                }
            };
            this.seasonalities = Object.assign(this.seasonalities,a_obj);
        }

        //Weekly seasonality
        if((this.getDiff(first,last) < 14)||(this.getDiff(first,last) >= 7)){
        weekly_disable = true;
        }
        fourier_order = this.parse_seasonality_args(
            "weekly",this.weekly_seasonality,weekly_disable,3);
        if(fourier_order > 0){
            let a_obj = {
                "weekly":{
                  "period":7,
                  "fourier_order": fourier_order,
                  "prior_scale": this.seasonality_prior_scale,
                }
            };
            this.seasonalities = Object.assign(this.seasonalities,a_obj);
        }

        //Daily seasonality
        if((this.getDiff(first,last) < 2) || (this.getDiff(first,last) >= 1)){
        daily_disable = true;
        }      
        fourier_order = this.parse_seasonality_args(
            "daily",this.dalily_seasonality,daily_disable,4);
        if(fourier_order > 0){
            if(fourier_order > 0){
                let a_obj = {
                    "daily":{
                      "period":1,
                      "fourier_order": fourier_order,
                      "prior_scale": this.seasonality_prior_scale,
                    }
                };
                this.seasonalities = Object.assign(this.seasonalities,a_obj);
            }
        }
    }
    /*linear_growth_init*/
    linear_growth_init(df){
        /*Initialize linear growth.

        Provides a strong initialization for linear growth by calculating the
        growth and offset parameters that pass the function through the first
        and last points in the time series.

        Parameters
        ----------
        df: pd.DataFrame with columns ds (date), y_scaled (scaled time series),
            and t (scaled time).

        Returns
        -------
        A tuple (k, m) with the rate (k) and offset (m) of the linear growth
        function.*/
        let min;
        let max; 
        let i0;
        let i1;

        let date = [];
        
        for(let i=0; i<prophet_js.shape0(df); i++){
            date[i] = new Date(df[i].ds);
        }

        min = date[0];
        max = date[0];
        i0 = 0;
        i1 = 0;

        for(let i = 0; i< prophet_js.shape0(f_df)-1; i++){/*dsの最小値を求める*/
            if(min.getTime() > date[i+1].getTime()){
                min = date[i+1];
                i0 = i+1;
                console.log("i0");
                console.log(i0);
                console.log("min");
                console.log(min);
            }
        }

        for(let i = 0; i< prophet_js.shape0(f_df)-1; i++){/*dsの最大値を求める*/
            if(max.getTime() < date[i+1].getTime()){
                max = date[i+1];
                i1 = i+1;
                console.log("i1");
                console.log(i1);
                console.log("max");
                console.log(max);
            }
        }
       let T = df[i1].t - df[i0].t;
       let k = (df[i1].y_scaled - df[i0].y_scaled)/T;
       let m = df[i0].y_scaled - k * df[i0].t;
       return (k,m);
    }


    fit(f_df){
    /*"""Fit the Prophet model.

        This sets this.params to contain the fitted model parameters. It is a
        dictionary parameter names as keys and the following items:
            k (Mx1 array): M posterior samples of the initial slope.
            m (Mx1 array): The initial intercept.
            delta (MxN array): The slope change at each of N changepoints.
            beta (MxK matrix): Coefficients for K seasonality features.
            sigma_obs (Mx1 array): Noise level.
        Note that M=1 if MAP estimation.

        Parameters
        ----------
        df: pd.DataFrame containing the history. Must have columns ds (date
            type) and y, the time series. If this.growth is 'logistic', then
            df must also have a column cap that specifies the capacity at
            each ds.
        kwargs: Additional arguments passed to the optimizing or sampling
            functions in Stan.

        Returns
        -------
        The fitted Prophet object.
        """*/

        let len;
        let kinit;
        let model;
        let his_date = [];
        let df_c = []; //f_dfチェック用配列
        let stan_fit;


        if(this.history != null){
            console.log("Prophet object can only be fit once. Instantiate a new object.");
        }
        this.check_df_log("f_df",f_df);
        let history = f_df;
        this.check_df_log("history",history);

        len = this.shape0(history);
        if(len < 2){
            console.log("Dataframe has less than 2 non-NaN rows.");
        }
        //日付順にソート
        f_df.sort(function(a,b){
        return(a.ds > b.ds ?1 :-1);
        });

        //"ds"のキーの値のみ取得し配列に格納
        for(let a_c_cnt in f_df){
            his_date.push(f_df[a_c_cnt].ds);
        }
        this.check_df_log("his_date",his_date);
        this.history_dates = his_date;

        history =  this.setup_dataframe(history,true);
        history.sort(function(a,b){
            return (a.ds < b.ds ? -1 : 1);
        });
        this.history = history;
        this.check_df_log("history",history);
        this.set_auto_seasonalities();
        let seasonal_res = [];
        seasonal_res = this.make_all_seasonality_features(history);
        let seasonal_features = seasonal_res[0];
        let prior_scales = seasonal_res[1];
        this.set_changepoints();
        let A = this.get_changepoint_matrix();

        let dat = {
            "T": prophet_js.shape0(history),
            "K": prophet_js.shape1(seasonal_features),
            "S": this.changepoints_t.length,
            "y": history["y_scaled"],
            "t": history["t"],
            "A": A,
            "t_change": this.changepoints_t,
            "X": seasonal_features,
            "sigmas": prior_scales,
            "tau": this.changepoint_prior_scale,
        };

        if(this.growth == "linear"){
            kinit = this.linear_growth_init(history);
        }

        model = prophet_stan_models(this.growth);

        function stan_init(){
            let dict = {
                "k": kinit[0],
                "m": kinit[1],
                "delta": nj.zeros(this.changepoints_t.length),
                "beta": nj.zeros(prophet_js.shape1(seasonal_features)),
                "sigma_obs": 1,
            }
            return dict;
        }
        let history_c;
        history_c.length = 0;

        for(let a_c_cnt in history_c){
            history_c.push(history[a_c_cnt].y); //チェック用配列にyの値を入れていく
        }

        if(Math.max(history_c) == Math.min(history_c)){
            console.log("972:Math.max(history_c) == Math.min(history_c)")
            //Nothing to fit
            this.params = stan_init();
            this.params["sigma_obs"] = 1e-9;
            for(par in this.params){
                this.params[par] = nj.array([this.params[par]]);
            }
        }
        else if(this.mcmc_samples > 0){
            stan_fit = model.sampling(
                dat,
                init = stan_init,
                iter = this.mcmc_samples,
                arguments
            );
            for(par in stan_fit.model_pars){
                this.params[par] = stan_fit[par]
            }
        }
        else
            try{
                params = model.optimaizing(
                    dat,init = stan_init, iter =1e4, arguments)
            }
            catch (e){
                console.log("RuntimeError")
                params = model.optimaizing(
                    dat,init = stan_init, iter = 1e4, algotithm = "Newton",arguments
                )
            }
            for(par in params){
                this.params[par] = params[par].reshape((1,-1));
            }

            if(this.changepoints.length == 0){
                this.params["k"] = this.params["k"]+this.params["delta"];
                this.params["delta"] = nj.zeros(this.params["delta"].shape);
            }

        return this;
    }
    prophet_stan_models(growth){

    }
    predict(df=null){
    /*Predict using the prophet model.

        Parameters
        ----------
        df: pd.DataFrame with dates for predictions (column ds), and capacity
            (column cap) if logistic growth. If not provided, predictions are
            made on the history.

        Returns
        -------
        A pd.DataFrame with the forecast components.*/
        let df2_trend = [];
        let df2_seasonal = [];
        let df2_yhat = [];

        if(df == null){
            df = this.history;
        }
        else
        {
            if(prophet_js.shape0(prophet_js.shape0) == 0){
                console.log("Dataframe has no rows.");
            }
            df = this.setup_dataframe(df);
        }
        df["trend"] = this.predict_trend();
        let seasonal_components = this.predict_seasonal_components(df);
        let intervals = this.predict_uncertainty(df);

        //Drop columns except ds, cap, floor, and trend
        let cols = ["ds","trend"];
        if("cap" in df){
            cols.push("cap");
        }
        if(this.logistic_floor ==true){
            cols.push("floor");
        }
        //Add in forecast components

        let df2 = concat((df[cols],intervals,seasonal_components),axis=1);
        /*
        df2['yhat'] = df2['trend'] + df2['seasonal'];
        for(let a_c_cnt in array){
        c_array.push(array[a_c_cnt].pra); //チェック用配列にyの値を入れていく
        */
        return df2;    
    }

    picewise_linear(t,deltas,k,m,changepoints_ts){
    /*Evaluate the piecewise linear function.

        Parameters
        ----------
        t: np.array of times on which the function is evaluated.
        deltas: np.array of rate changes at each changepoint.
        k: Float initial rate.
        m: Float initial offset.
        changepoint_ts: np.array of changepoint times.

        Returns
        -------
        Vector y(t).*/
        
        //Intercept changes
        let gammas = -changepoints_ts * deltas;
        //Get cumulative slope and intercept at each t
        let k_t = k*nj.ones(t);
        let m_t = m*nj.ones(t);
        
        let result = enumrate_t(this.changepoints_ts);
        let idx = result[0];
        let s = result[1];

        return k_t * t +m_t;
    }
    predict_trend(df){
        let params_k = [];
        let params_m = [];
        let params_delta = [];

        for(let a_c_cnt in params){
            params_k.push(params_k[a_c_cnt].k);
            params_m.push(params_m[a_c_cnt].m);
            params_delta.push(params_delta[a_c_cnt].delta); 
        }
        let k = prophet_js.average(params_k);
        let m = prophet_js.average(params_m);
        let deltas = prophet_js.average(params_delta);

        let t = nj.array(df["t"]);
        trend =this.piecewise_linear(t, deltas, k, m, this.changepoints_t);

        return trend * this.y_scale + df['floor'];
    }

    predict_seasonal_components(df){
    /*Predict seasonality components, holidays, and added regressors.

        Parameters
        ----------
        df: Prediction dataframe.

        Returns
        -------
        Dataframe with seasonal components.*/
        
        let seasonal_features,_ = this.make_all_seasonality_features(df);
        let lower_p = 100 * (1.0 - this.interval_width) / 2;
        let upper_p = 100 * (1.0 + this.interval_width) / 2;
        for(x in seasonal_features);
        let components = [
                {"col":nj.aprophet_js.range(prophet_js.shape1(seasonal_features))},
                {"component":x[0].split("_delim_")}
            ];
                         
        //Add total for all regression components
        components = components.push({"col": nj.aprophet_js.range(prophet_js.shape1(seasonal_features)),
        "component": "seasonal",})
        //Add totals for seasonality, holiday, and extra regressors
        components =this.add_group_component(components, "seasonalities", this.seasonalities.keys());

        //Remove the placeholder
        components = components[components["component"] != "zeros"];
        let X = [];
        for(let i = 0; i<seasonal_features.length; i++){
            X[i] = seasonal_features[i]
        }
        let data = {};
        let component = components[0].component;
        let features = components;

        cols = features[0].cols;
        let comp_beta_h = this.params.filter(function(item){
            if(item.u == beta)
            return true;
        });
        console.log("comp_beta_h");
        console.log(comp_beta_h);
        comp_beta = comp_beta_h.array;
        for(let i; i<seasonal_features.length; i++){
            comp_features[i] = X[i];
        }
        comp_beta_h.length = 0;
        for(let i = 0; i < comp_beta.length; i++){
            comp_beta_h.push(comp_beta[i]); 
        }
        comp_beta = comp_beta_h;

        for(let i = 0; i < comp_features.length; i++){
            comp = [(comp_features[i]*comp_beta[0])*this.y_scale];
        } // 二つの行列同士の積

        data[component] = nj.nanmean(comp, axis=1);
        for(let i = 0; i<comp.length; i++){
            data[component][i] =  comp[i]; 
        }
        data[component + '_lower'] = np.nanpercentile(comp, lower_p,axis=1);
        data[component + '_upper'] = np.nanpercentile(comp, upper_p,axis=1);
            
        return pd.DataFrame(data);
    }
    add_group_component(components, name, group){
        /*Adds a component with given name that contains all of the components
        in group.

        Parameters
        ----------
        components: Dataframe with components.
        name: Name of new group component.
        group: List of components that form the group.

        Returns
        -------
        Dataframe with components.*/ 

        let new_comp = push(components[components["component"].isin(set(group))]);
        new_comp["component"] = name;
        components = components.push(new_comp);
        return components;
    }

    sample_posterior_predictive(df){
    /*
    Prophet posterior predictive samples.

        Parameters
        ----------
        df: Prediction dataframe.

        Returns
        -------
        Dictionary with posterior predictive samples for each component.
    */ 
        let n_iterations = prophet_js.shape0(this.params["k"]);
        let samp_per_iter = Math.max(1, int(nj.ceil(
            this.uncertainty_samples / float(n_iterations)
        )));

        //Generate seasonality features once so we can re-use them.
        let seasonal_features,_ = this.make_all_seasonality_features(df);

        sim_values = {"yhat": [], "trend": [], "seasonal": []};
        for(i in prophet_js.range(n_iterations)){
            for(_j in prophet_js.range(samp_per_iter)){
                let sim = this.sample_model(df, seasonal_features, i);
                for(key in sim_values){
                    sim_values[key].push(sim[key]);
                }
            }
        }
        for(k in sim_values){
            for(v in sim_valus[k]){
                sim_values[k] = nj.stack(v,-1);
            }
        return sim_values;
        }
    }
    predict_sample(df){
    /*
    Sample from the posterior predictive distribution.

        Parameters
        ----------
        df: Dataframe with dates for predictions (column ds), and capacity
            (column cap) if logistic growth.

        Returns
        -------
        Dictionary with keys "trend", "seasonal", and "yhat" containing
        posterior predictive samples for that component. "seasonal" is the sum
        of seasonalities, holidays, and added regressors.
    */
        df = this.setup_dataframe(df.copy());
        let sim_values = this.sample_posterior_predictive(df);
        return sim_values;
    }

    predict_uncertainty(df){
    /*
    Prediction intervals for yhat and trend.

        Parameters
        ----------
        df: Prediction dataframe.

        Returns
        -------
        Dataframe with uncertainty intervals.
    */
        let sim_values = this.sample_posterior_predictive(df);

        let lower_p = 100 * (1.0 - this.interval_width) / 2;
        let upper_p = 100 * (1.0 + this.interval_width) / 2;

        series = {};
        for(key in ["yhat","trend"]){
            //???
            series['{}_lower'.format(key)] = np.nanpercentile(
                sim_values[key], lower_p, axis=1);
            series['{}_upper'.format(key)] = np.nanpercentile(
                sim_values[key], upper_p, axis=1);
        }
        return series;
    }

    sample_model(df, seasonal_features, iteration){
    /*
    Simulate observations from the extrapolated generative model.

        Parameters
        ----------
        df: Prediction dataframe.
        seasonal_features: pd.DataFrame of seasonal features.
        iteration: Int sampling iteration to use parameters from.

        Returns
        -------
        Dataframe with trend, seasonality, and yhat, each like df['t'].
    */ 
        let trend = this.sample_predictive_trend(df, iteration);
    
        let beta = this.params['beta'][iteration];
        let seasonal = np.matmul(seasonal_features.as_matrix(), beta) * this.y_scale;
    
        let sigma = this.params['sigma_obs'][iteration];
        let noise = np.random.normal(0, sigma, df.shape[0]) * this.y_scale;
    
        return pd.DataFrame({
            'yhat': trend + seasonal + noise,
            'trend': trend,
            'seasonal': seasonal,
        });
    }
    sample_predictive_trend(df, iteration){
    /*
    Simulate the trend using the extrapolated generative model.

        Parameters
        ----------
        df: Prediction dataframe.
        iteration: Int sampling iteration to use parameters from.

        Returns
        -------
        np.array of simulated trend over df['t'].
    */
        let dt;
        let N;
        let S;
        let prob_change;
        let n_changes;
        let changepoint_ts_new;
        let k = this.params["k"][iteration];
        let m = this.params["m"][iteration];
        let deltas = this.params["delta"][iteration];
        let t = nj.array(dt.t);
        let T = Math.max(t);

        if(T > 1){
            dt = nj.diff(this.history.t);
            dt = Math.min(dt);
            //Number of time periods in the future
            N = nj.ceil((T - 1) / float(dt));
            S = this.changepoints_t.length;

            prob_change = Math.min(1, (S * (T - 1)) / N);
            n_changes = nj.random.binomial(N, prob_change);

            //Sample ts
            changepoint_ts_new = sorted(nj.random.uniform(1, T, n_changes));
        }
        else{
            //Case where we're not extrapolating.
            changepoint_ts_new = [];
            n_changes = 0;
        }
        //Get the empirical scale of the deltas, plus epsilon to avoid NaNs.
        let lambda_ = nj.mean(nj.abs(deltas)) + 1e-8;

        //Sample deltas
        let deltas_new = nj.random.laplace(0, lambda_, n_changes);

        //Prepend the times and deltas from the history
        changepoint_ts = np.concatenate((this.changepoints_t,
                                         changepoint_ts_new));
        deltas = np.concatenate((deltas, deltas_new));
        trend = this.piecewise_linear(t, deltas, k, m, changepoint_ts);

        return trend * this.y_scale + df["floor"];
    }

    make_future_dateframe(period,freq = "D",include_history=true){
    /*
    Simulate the trend using the extrapolated generative model.

        Parameters
        ----------
        periods: Int number of periods to forecast forward.
        freq: Any valid frequency for pd.date_prophet_js.range, such as 'D' or 'M'.
        include_history: Boolean to include the historical dates in the data
            frame for predictions.

        Returns
        -------
        pd.Dataframe that extends forward from the end of this.history for the
        requested number of periods.
    */ 
        let last_date = Math.max(this.history_dates);
        let dates =  pd.date_prophet_js.range(
            start=last_date,
            periods=periods + 1,  // An extra in case we include start
            freq=freq)
        dates = dates[dates > last_date]; // Drop start if equals last_date
        dates = dates[periods];  // Return correct number of periods

        if(include_histor){
            dates = np.concatenate((np.array(this.history_dates), dates));
        }

        return pd.DataFrame({'ds': dates});
    }

    copy(cutoff = null){
      /*
      Copy Prophet object

        Parameters
        ----------
        cutoff: pd.Timestamp or None, default None.
            cuttoff Timestamp for changepoints member variable.
            changepoints are only retained if 'changepoints <= cutoff'

        Returns
        -------
        Prophet class object with the same parameter with model variable
      */  

      if(this.specified_changepoints){
          let changepoints = this.changepoints;
          if(cutoff = null);
          changepoints = changepoints[changepoints <= cutoff];
      }
      else{
          changepoints = null;
      }
      return Prophet(
        growth=this.growth,
        n_changepoints=this.n_changepoints,
        changepoints=changepoints,
        yearly_seasonality=this.yearly_seasonality,
        weekly_seasonality=this.weekly_seasonality,
        daily_seasonality=this.daily_seasonality,
        holidays=this.holidays,
        seasonality_prior_scale=this.seasonality_prior_scale,
        changepoint_prior_scale=this.changepoint_prior_scale,
        holidays_prior_scale=this.holidays_prior_scale,
        mcmc_samples=this.mcmc_samples,
        interval_width=this.interval_width,
        uncertainty_samples=this.uncertainty_samples
      );
    }
}

let test = new prophet_js();

let f_df =[
    {"ds":"2007/1/1",  "y":"5.8"},
    {"ds":"2007/1/2",  "y":"8.3"},
    {"ds":"2007/1/3",  "y":"8.6"},
    {"ds":"2007/1/4",  "y":"7.5"},
    {"ds":"2007/1/5",  "y":"7.1"},
    {"ds":"2007/1/6",  "y":"6.1"},
    {"ds":"2007/1/7",  "y":"8.7"},
    {"ds":"2007/1/8",  "y":"7.1"},
    {"ds":"2007/1/9",  "y":"7"},
    {"ds":"2007/1/10",  "y":"7.4"},
    {"ds":"2007/1/11",  "y":"7.4"},
    {"ds":"2007/1/12",  "y":"6.7"},
    {"ds":"2007/1/13",  "y":"6.9"},
    {"ds":"2007/1/14",  "y":"6.5"},
    {"ds":"2007/1/15",  "y":"7.9"},
    {"ds":"2007/1/16",  "y":"8"},
    {"ds":"2007/1/17",  "y":"7"},
    {"ds":"2007/1/18",  "y":"8.1"},
    {"ds":"2007/1/19",  "y":"7.5"},
    {"ds":"2007/1/20",  "y":"5"},
    {"ds":"2007/1/21",  "y":"6.7"},
    {"ds":"2007/1/22",  "y":"7.4"},
    {"ds":"2007/1/23",  "y":"8.2"},
    {"ds":"2007/1/24",  "y":"7.6"},
    {"ds":"2007/1/25",  "y":"7.9"},
    {"ds":"2007/1/26",  "y":"8.4"},
    {"ds":"2007/1/27",  "y":"10.1"},
    {"ds":"2007/1/28",  "y":"8.9"},
    {"ds":"2007/1/29",  "y":"7.7"},
    {"ds":"2007/1/30",  "y":"9"},
    {"ds":"2007/1/31",  "y":"10.3"},
    {"ds":"2007/2/1",  "y":"8.5"},
    {"ds":"2007/2/2",  "y":"6.3"},
    {"ds":"2007/2/3",  "y":"7.3"},
    {"ds":"2007/2/4",  "y":"7.4"},
    {"ds":"2007/2/5",  "y":"8.5"},
    {"ds":"2007/2/6",  "y":"11.2"},
    {"ds":"2007/2/7",  "y":"10.2"},
    {"ds":"2007/2/8",  "y":"9.8"},
    {"ds":"2007/2/9",  "y":"10.3"},
    {"ds":"2007/2/10",  "y":"10.8"},
    {"ds":"2007/2/11",  "y":"8.8"},
    {"ds":"2007/2/12",  "y":"8.4"},
    {"ds":"2007/2/13",  "y":"8.9"},
    {"ds":"2007/2/14",  "y":"10"},
    {"ds":"2007/2/15",  "y":"9.9"},
    {"ds":"2007/2/16",  "y":"8.2"},
    {"ds":"2007/2/17",  "y":"6.9"},
    {"ds":"2007/2/18",  "y":"6.8"},
    {"ds":"2007/2/19",  "y":"9.3"},
    {"ds":"2007/2/20",  "y":"7"},
    {"ds":"2007/2/21",  "y":"9.8"},
    {"ds":"2007/2/22",  "y":"10.9"},
    {"ds":"2007/2/23",  "y":"11.1"},
    {"ds":"2007/2/24",  "y":"6.6"},
    {"ds":"2007/2/25",  "y":"3.7"},
    {"ds":"2007/2/26",  "y":"6.1"},
    {"ds":"2007/2/27",  "y":"9.4"},
    {"ds":"2007/2/28",  "y":"10"},
    {"ds":"2007/3/1",  "y":"9"},
    {"ds":"2007/3/2",  "y":"9.5"},
    {"ds":"2007/3/3",  "y":"11.8"},
    {"ds":"2007/3/4",  "y":"14.3"},
    {"ds":"2007/3/5",  "y":"17.1"},
    {"ds":"2007/3/6",  "y":"12.8"},
    {"ds":"2007/3/7",  "y":"7.7"},
    {"ds":"2007/3/8",  "y":"7.9"},
    {"ds":"2007/3/9",  "y":"7.6"},
    {"ds":"2007/3/10",  "y":"9.9"},
    {"ds":"2007/3/11",  "y":"9.2"},
    {"ds":"2007/3/12",  "y":"7.6"},
    {"ds":"2007/3/13",  "y":"7.8"},
    {"ds":"2007/3/14",  "y":"7.6"},
    {"ds":"2007/3/15",  "y":"8.8"},
    {"ds":"2007/3/16",  "y":"7.9"},
    {"ds":"2007/3/17",  "y":"6.7"},
    {"ds":"2007/3/18",  "y":"6.3"},
    {"ds":"2007/3/19",  "y":"7.6"},
    {"ds":"2007/3/20",  "y":"8.3"},
    {"ds":"2007/3/21",  "y":"8.9"},
    {"ds":"2007/3/22",  "y":"11.7"},
    {"ds":"2007/3/23",  "y":"12.4"},
    {"ds":"2007/3/24",  "y":"13.4"},
    {"ds":"2007/3/25",  "y":"15.6"},
    {"ds":"2007/3/26",  "y":"14.9"},
    {"ds":"2007/3/27",  "y":"13.6"},
    {"ds":"2007/3/28",  "y":"15.3"},
    {"ds":"2007/3/29",  "y":"18.1"},
    {"ds":"2007/3/30",  "y":"13.2"},
    {"ds":"2007/3/31",  "y":"13.1"},
    {"ds":"2007/4/1",  "y":"17.7"},
    {"ds":"2007/4/2",  "y":"14.3"},
    {"ds":"2007/4/3",  "y":"8.8"},
    {"ds":"2007/4/4",  "y":"7.3"},
    {"ds":"2007/4/5",  "y":"9.8"},
    {"ds":"2007/4/6",  "y":"11.1"},
    {"ds":"2007/4/7",  "y":"13.2"},
    {"ds":"2007/4/8",  "y":"13.6"},
    {"ds":"2007/4/9",  "y":"12"},
    {"ds":"2007/4/10",  "y":"13.8"},
    {"ds":"2007/4/11",  "y":"12.1"},
    {"ds":"2007/4/12",  "y":"13.3"},
    {"ds":"2007/4/13",  "y":"16.7"},
    {"ds":"2007/4/14",  "y":"19"},
    {"ds":"2007/4/15",  "y":"15.2"},
    {"ds":"2007/4/16",  "y":"10.6"},
    {"ds":"2007/4/17",  "y":"9.1"},
    {"ds":"2007/4/18",  "y":"8.8"},
    {"ds":"2007/4/19",  "y":"9.9"},
    {"ds":"2007/4/20",  "y":"14"},
    {"ds":"2007/4/21",  "y":"19.2"},
    {"ds":"2007/4/22",  "y":"20"},
    {"ds":"2007/4/23",  "y":"15"},
    {"ds":"2007/4/24",  "y":"13.1"},
    {"ds":"2007/4/25",  "y":"13.2"},
    {"ds":"2007/4/26",  "y":"16.4"},
    {"ds":"2007/4/27",  "y":"14.2"},
    {"ds":"2007/4/28",  "y":"15.2"},
    {"ds":"2007/4/29",  "y":"16.4"},
    {"ds":"2007/4/30",  "y":"19.2"},
    {"ds":"2007/5/1",  "y":"17.2"},
    {"ds":"2007/5/2",  "y":"19.1"},
    {"ds":"2007/5/3",  "y":"19.5"},
    {"ds":"2007/5/4",  "y":"21.5"},
    {"ds":"2007/5/5",  "y":"22.2"},
    {"ds":"2007/5/6",  "y":"18"},
    {"ds":"2007/5/7",  "y":"19.5"},
    {"ds":"2007/5/8",  "y":"20.1"},
    {"ds":"2007/5/9",  "y":"23.1"},
    {"ds":"2007/5/10",  "y":"20.3"},
    {"ds":"2007/5/11",  "y":"18.5"},
    {"ds":"2007/5/12",  "y":"19"},
    {"ds":"2007/5/13",  "y":"20.7"},
    {"ds":"2007/5/14",  "y":"18.9"},
    {"ds":"2007/5/15",  "y":"18.4"},
    {"ds":"2007/5/16",  "y":"19.1"},
    {"ds":"2007/5/17",  "y":"17.8"},
    {"ds":"2007/5/18",  "y":"21.2"},
    {"ds":"2007/5/19",  "y":"19.2"},
    {"ds":"2007/5/20",  "y":"18.9"},
    {"ds":"2007/5/21",  "y":"18.1"},
    {"ds":"2007/5/22",  "y":"20.8"},
    {"ds":"2007/5/23",  "y":"22.4"},
    {"ds":"2007/5/24",  "y":"22.4"},
    {"ds":"2007/5/25",  "y":"19.1"},
    {"ds":"2007/5/26",  "y":"23.1"},
    {"ds":"2007/5/27",  "y":"23.2"},
    {"ds":"2007/5/28",  "y":"16.3"},
    {"ds":"2007/5/29",  "y":"18"},
    {"ds":"2007/5/30",  "y":"18.7"},
    {"ds":"2007/5/31",  "y":"18.8"},
    {"ds":"2007/6/1",  "y":"18.4"},
    {"ds":"2007/6/2",  "y":"20.9"},
    {"ds":"2007/6/3",  "y":"21.7"},
    {"ds":"2007/6/4",  "y":"21.5"},
    {"ds":"2007/6/5",  "y":"21.8"},
    {"ds":"2007/6/6",  "y":"22.2"},
    {"ds":"2007/6/7",  "y":"22.4"},
    {"ds":"2007/6/8",  "y":"22.4"},
    {"ds":"2007/6/9",  "y":"22.2"},
    {"ds":"2007/6/10",  "y":"19.8"},
    {"ds":"2007/6/11",  "y":"20.9"},
    {"ds":"2007/6/12",  "y":"23.5"},
    {"ds":"2007/6/13",  "y":"23.6"},
    {"ds":"2007/6/14",  "y":"21.8"},
    {"ds":"2007/6/15",  "y":"24"},
    {"ds":"2007/6/16",  "y":"24.8"},
    {"ds":"2007/6/17",  "y":"22.1"},
    {"ds":"2007/6/18",  "y":"23.8"},
    {"ds":"2007/6/19",  "y":"26.1"},
    {"ds":"2007/6/20",  "y":"25.5"},
    {"ds":"2007/6/21",  "y":"26.4"},
    {"ds":"2007/6/22",  "y":"23.9"},
    {"ds":"2007/6/23",  "y":"25.4"},
    {"ds":"2007/6/24",  "y":"22.9"},
    {"ds":"2007/6/25",  "y":"21"},
    {"ds":"2007/6/26",  "y":"22.8"},
    {"ds":"2007/6/27",  "y":"26.4"},
    {"ds":"2007/6/28",  "y":"26.5"},
    {"ds":"2007/6/29",  "y":"27.1"},
    {"ds":"2007/6/30",  "y":"25.4"},
    {"ds":"2007/7/1",  "y":"23.3"},
    {"ds":"2007/7/2",  "y":"24"},
    {"ds":"2007/7/3",  "y":"24.3"},
    {"ds":"2007/7/4",  "y":"21.5"},
    {"ds":"2007/7/5",  "y":"24.7"},
    {"ds":"2007/7/6",  "y":"25.8"},
    {"ds":"2007/7/7",  "y":"23.9"},
    {"ds":"2007/7/8",  "y":"22.9"},
    {"ds":"2007/7/9",  "y":"23.7"},
    {"ds":"2007/7/10",  "y":"23.3"},
    {"ds":"2007/7/11",  "y":"24.7"},
    {"ds":"2007/7/12",  "y":"24.8"},
    {"ds":"2007/7/13",  "y":"24.9"},
    {"ds":"2007/7/14",  "y":"22"},
    {"ds":"2007/7/15",  "y":"23.8"},
    {"ds":"2007/7/16",  "y":"24.8"},
    {"ds":"2007/7/17",  "y":"19.8"},
    {"ds":"2007/7/18",  "y":"20.5"},
    {"ds":"2007/7/19",  "y":"22.2"},
    {"ds":"2007/7/20",  "y":"24.5"},
    {"ds":"2007/7/21",  "y":"25.2"},
    {"ds":"2007/7/22",  "y":"25"},
    {"ds":"2007/7/23",  "y":"25.2"},
    {"ds":"2007/7/24",  "y":"26.6"},
    {"ds":"2007/7/25",  "y":"26.2"},
    {"ds":"2007/7/26",  "y":"27.8"},
    {"ds":"2007/7/27",  "y":"28.8"},
    {"ds":"2007/7/28",  "y":"28.7"},
    {"ds":"2007/7/29",  "y":"27.1"},
    {"ds":"2007/7/30",  "y":"22.4"},
    {"ds":"2007/7/31",  "y":"23.6"},
    {"ds":"2007/8/1",  "y":"27.4"},
    {"ds":"2007/8/2",  "y":"28.7"},
    {"ds":"2007/8/3",  "y":"28.8"},
    {"ds":"2007/8/4",  "y":"30.2"},
    {"ds":"2007/8/5",  "y":"29.5"},
    {"ds":"2007/8/6",  "y":"29"},
    {"ds":"2007/8/7",  "y":"29.4"},
    {"ds":"2007/8/8",  "y":"29.7"},
    {"ds":"2007/8/9",  "y":"30.1"},
    {"ds":"2007/8/10",  "y":"31.1"},
    {"ds":"2007/8/11",  "y":"31.3"},
    {"ds":"2007/8/12",  "y":"29.4"},
    {"ds":"2007/8/13",  "y":"29.3"},
    {"ds":"2007/8/14",  "y":"30.1"},
    {"ds":"2007/8/15",  "y":"31.5"},
    {"ds":"2007/8/16",  "y":"32.7"},
    {"ds":"2007/8/17",  "y":"31.7"},
    {"ds":"2007/8/18",  "y":"25.5"},
    {"ds":"2007/8/19",  "y":"28.3"},
    {"ds":"2007/8/20",  "y":"30.5"},
    {"ds":"2007/8/21",  "y":"30.2"},
    {"ds":"2007/8/22",  "y":"31.7"},
    {"ds":"2007/8/23",  "y":"26.5"},
    {"ds":"2007/8/24",  "y":"27.5"},
    {"ds":"2007/8/25",  "y":"28.2"},
    {"ds":"2007/8/26",  "y":"29.2"},
    {"ds":"2007/8/27",  "y":"29.3"},
    {"ds":"2007/8/28",  "y":"28.6"},
    {"ds":"2007/8/29",  "y":"24.9"},
    {"ds":"2007/8/30",  "y":"24.5"},
    {"ds":"2007/8/31",  "y":"24.6"},
    {"ds":"2007/9/1",  "y":"22.4"},
    {"ds":"2007/9/2",  "y":"23.5"},
    {"ds":"2007/9/3",  "y":"25.4"},
    {"ds":"2007/9/4",  "y":"27.2"},
    {"ds":"2007/9/5",  "y":"27.2"},
    {"ds":"2007/9/6",  "y":"27.3"},
    {"ds":"2007/9/7",  "y":"27.1"},
    {"ds":"2007/9/8",  "y":"28.4"},
    {"ds":"2007/9/9",  "y":"27.5"},
    {"ds":"2007/9/10",  "y":"26.3"},
    {"ds":"2007/9/11",  "y":"24.8"},
    {"ds":"2007/9/12",  "y":"22.1"},
    {"ds":"2007/9/13",  "y":"23.9"},
    {"ds":"2007/9/14",  "y":"25.8"},
    {"ds":"2007/9/15",  "y":"27.5"},
    {"ds":"2007/9/16",  "y":"28.3"},
    {"ds":"2007/9/17",  "y":"29"},
    {"ds":"2007/9/18",  "y":"25.1"},
    {"ds":"2007/9/19",  "y":"24.4"},
    {"ds":"2007/9/20",  "y":"27.3"},
    {"ds":"2007/9/21",  "y":"27.4"},
    {"ds":"2007/9/22",  "y":"27.6"},
    {"ds":"2007/9/23",  "y":"23.7"},
    {"ds":"2007/9/24",  "y":"22.4"},
    {"ds":"2007/9/25",  "y":"24.9"},
    {"ds":"2007/9/26",  "y":"23.2"},
    {"ds":"2007/9/27",  "y":"23.6"},
    {"ds":"2007/9/28",  "y":"26.7"},
    {"ds":"2007/9/29",  "y":"18.4"},
    {"ds":"2007/9/30",  "y":"16.8"},
    {"ds":"2007/10/1",  "y":"18.1"},
    {"ds":"2007/10/2",  "y":"19.8"},
    {"ds":"2007/10/3",  "y":"21"},
    {"ds":"2007/10/4",  "y":"22.1"},
    {"ds":"2007/10/5",  "y":"22.5"},
    {"ds":"2007/10/6",  "y":"20.8"},
    {"ds":"2007/10/7",  "y":"19.9"},
    {"ds":"2007/10/8",  "y":"21.1"},
    {"ds":"2007/10/9",  "y":"19.2"},
    {"ds":"2007/10/10",  "y":"19.9"},
    {"ds":"2007/10/11",  "y":"20.8"},
    {"ds":"2007/10/12",  "y":"22.1"},
    {"ds":"2007/10/13",  "y":"19.5"},
    {"ds":"2007/10/14",  "y":"18.3"},
    {"ds":"2007/10/15",  "y":"18.6"},
    {"ds":"2007/10/16",  "y":"16.2"},
    {"ds":"2007/10/17",  "y":"17.9"},
    {"ds":"2007/10/18",  "y":"17.7"},
    {"ds":"2007/10/19",  "y":"17.4"},
    {"ds":"2007/10/20",  "y":"17.5"},
    {"ds":"2007/10/21",  "y":"17.2"},
    {"ds":"2007/10/22",  "y":"17.6"},
    {"ds":"2007/10/23",  "y":"18.9"},
    {"ds":"2007/10/24",  "y":"16.8"},
    {"ds":"2007/10/25",  "y":"17.8"},
    {"ds":"2007/10/26",  "y":"17.4"},
    {"ds":"2007/10/27",  "y":"16.8"},
    {"ds":"2007/10/28",  "y":"18.6"},
    {"ds":"2007/10/29",  "y":"21.3"},
    {"ds":"2007/10/30",  "y":"18.8"},
    {"ds":"2007/10/31",  "y":"17.3"},
    {"ds":"2007/11/1",  "y":"17.5"},
    {"ds":"2007/11/2",  "y":"16.5"},
    {"ds":"2007/11/3",  "y":"15.5"},
    {"ds":"2007/11/4",  "y":"15.9"},
    {"ds":"2007/11/5",  "y":"16.4"},
    {"ds":"2007/11/6",  "y":"16"},
    {"ds":"2007/11/7",  "y":"16.3"},
    {"ds":"2007/11/8",  "y":"15.9"},
    {"ds":"2007/11/9",  "y":"16.2"},
    {"ds":"2007/11/10",  "y":"13.2"},
    {"ds":"2007/11/11",  "y":"14"},
    {"ds":"2007/11/12",  "y":"15.1"},
    {"ds":"2007/11/13",  "y":"16.7"},
    {"ds":"2007/11/14",  "y":"16.2"},
    {"ds":"2007/11/15",  "y":"16.5"},
    {"ds":"2007/11/16",  "y":"12.2"},
    {"ds":"2007/11/17",  "y":"10.1"},
    {"ds":"2007/11/18",  "y":"11.8"},
    {"ds":"2007/11/19",  "y":"9.7"},
    {"ds":"2007/11/20",  "y":"10.8"},
    {"ds":"2007/11/21",  "y":"10.7"},
    {"ds":"2007/11/22",  "y":"8.2"},
    {"ds":"2007/11/23",  "y":"9.2"},
    {"ds":"2007/11/24",  "y":"9.2"},
    {"ds":"2007/11/25",  "y":"12"},
    {"ds":"2007/11/26",  "y":"12.2"},
    {"ds":"2007/11/27",  "y":"13"},
    {"ds":"2007/11/28",  "y":"11.6"},
    {"ds":"2007/11/29",  "y":"9.7"},
    {"ds":"2007/11/30",  "y":"9.9"},
    {"ds":"2007/12/1",  "y":"11.4"},
    {"ds":"2007/12/2",  "y":"11.6"},
    {"ds":"2007/12/3",  "y":"10.5"},
    {"ds":"2007/12/4",  "y":"9.5"},
    {"ds":"2007/12/5",  "y":"8.6"},
    {"ds":"2007/12/6",  "y":"9.9"},
    {"ds":"2007/12/7",  "y":"11.1"},
    {"ds":"2007/12/8",  "y":"10.6"},
    {"ds":"2007/12/9",  "y":"10.1"},
    {"ds":"2007/12/10",  "y":"9.9"},
    {"ds":"2007/12/11",  "y":"10"},
    {"ds":"2007/12/12",  "y":"10.9"},
    {"ds":"2007/12/13",  "y":"9.2"},
    {"ds":"2007/12/14",  "y":"9.8"},
    {"ds":"2007/12/15",  "y":"8.5"},
    {"ds":"2007/12/16",  "y":"6.9"},
    {"ds":"2007/12/17",  "y":"7.5"},
    {"ds":"2007/12/18",  "y":"8"},
    {"ds":"2007/12/19",  "y":"7.5"},
    {"ds":"2007/12/20",  "y":"8.1"},
    {"ds":"2007/12/21",  "y":"9.4"},
    {"ds":"2007/12/22",  "y":"7.1"},
    {"ds":"2007/12/23",  "y":"8.3"},
    {"ds":"2007/12/24",  "y":"9.7"},
    {"ds":"2007/12/25",  "y":"8"},
    {"ds":"2007/12/26",  "y":"6.5"},
    {"ds":"2007/12/27",  "y":"7"},
    {"ds":"2007/12/28",  "y":"8"},
    {"ds":"2007/12/29",  "y":"10.6"},
    {"ds":"2007/12/30",  "y":"9.5"},
    {"ds":"2007/12/31",  "y":"6.5"},
    {"ds":"2008/1/1",  "y":"6"},
    {"ds":"2008/1/2",  "y":"6.2"},
    {"ds":"2008/1/3",  "y":"5.9"},
    {"ds":"2008/1/4",  "y":"7"},
    {"ds":"2008/1/5",  "y":"6"},
    {"ds":"2008/1/6",  "y":"7.5"},
    {"ds":"2008/1/7",  "y":"8.4"},
    {"ds":"2008/1/8",  "y":"9.7"},
    {"ds":"2008/1/9",  "y":"10.4"},
    {"ds":"2008/1/10",  "y":"9"},
    {"ds":"2008/1/11",  "y":"9.3"},
    {"ds":"2008/1/12",  "y":"6.9"},
    {"ds":"2008/1/13",  "y":"4.8"},
    {"ds":"2008/1/14",  "y":"4"},
    {"ds":"2008/1/15",  "y":"5.4"},
    {"ds":"2008/1/16",  "y":"5.9"},
    {"ds":"2008/1/17",  "y":"3.9"},
    {"ds":"2008/1/18",  "y":"3.6"},
    {"ds":"2008/1/19",  "y":"4.8"},
    {"ds":"2008/1/20",  "y":"5"},
    {"ds":"2008/1/21",  "y":"4.9"},
    {"ds":"2008/1/22",  "y":"4.4"},
    {"ds":"2008/1/23",  "y":"3"},
    {"ds":"2008/1/24",  "y":"5"},
    {"ds":"2008/1/25",  "y":"3.4"},
    {"ds":"2008/1/26",  "y":"4.1"},
    {"ds":"2008/1/27",  "y":"4.1"},
    {"ds":"2008/1/28",  "y":"4.7"},
    {"ds":"2008/1/29",  "y":"5.2"},
    {"ds":"2008/1/30",  "y":"8"},
    {"ds":"2008/1/31",  "y":"6.2"},
    {"ds":"2008/2/1",  "y":"5"},
    {"ds":"2008/2/2",  "y":"4.8"},
    {"ds":"2008/2/3",  "y":"1.5"},
    {"ds":"2008/2/4",  "y":"4.7"},
    {"ds":"2008/2/5",  "y":"5.6"},
    {"ds":"2008/2/6",  "y":"2.8"},
    {"ds":"2008/2/7",  "y":"5"},
    {"ds":"2008/2/8",  "y":"4.9"},
    {"ds":"2008/2/9",  "y":"2.4"},
    {"ds":"2008/2/10",  "y":"6.5"},
    {"ds":"2008/2/11",  "y":"6.8"},
    {"ds":"2008/2/12",  "y":"6.1"},
    {"ds":"2008/2/13",  "y":"3.1"},
    {"ds":"2008/2/14",  "y":"5.1"},
    {"ds":"2008/2/15",  "y":"5.7"},
    {"ds":"2008/2/16",  "y":"5.2"},
    {"ds":"2008/2/17",  "y":"3.5"},
    {"ds":"2008/2/18",  "y":"5.3"},
    {"ds":"2008/2/19",  "y":"5.4"},
    {"ds":"2008/2/20",  "y":"7.1"},
    {"ds":"2008/2/21",  "y":"8.6"},
    {"ds":"2008/2/22",  "y":"9.5"},
    {"ds":"2008/2/23",  "y":"7.3"},
    {"ds":"2008/2/24",  "y":"3.7"},
    {"ds":"2008/2/25",  "y":"4.8"},
    {"ds":"2008/2/26",  "y":"8.7"},
    {"ds":"2008/2/27",  "y":"6.4"},
    {"ds":"2008/2/28",  "y":"6.6"},
    {"ds":"2008/2/29",  "y":"7.8"},
    {"ds":"2008/3/1",  "y":"8.8"},
    {"ds":"2008/3/2",  "y":"8.6"},
    {"ds":"2008/3/3",  "y":"9.3"},
    {"ds":"2008/3/4",  "y":"8"},
    {"ds":"2008/3/5",  "y":"6.4"},
    {"ds":"2008/3/6",  "y":"7.4"},
    {"ds":"2008/3/7",  "y":"7.8"},
    {"ds":"2008/3/8",  "y":"8.6"},
    {"ds":"2008/3/9",  "y":"10.4"},
    {"ds":"2008/3/10",  "y":"9"},
    {"ds":"2008/3/11",  "y":"12.6"},
    {"ds":"2008/3/12",  "y":"9.7"},
    {"ds":"2008/3/13",  "y":"10.3"},
    {"ds":"2008/3/14",  "y":"13.3"},
    {"ds":"2008/3/15",  "y":"14.7"},
    {"ds":"2008/3/16",  "y":"14.5"},
    {"ds":"2008/3/17",  "y":"13.1"},
    {"ds":"2008/3/18",  "y":"12.6"},
    {"ds":"2008/3/19",  "y":"12.1"},
    {"ds":"2008/3/20",  "y":"9.2"},
    {"ds":"2008/3/21",  "y":"10.7"},
    {"ds":"2008/3/22",  "y":"11.9"},
    {"ds":"2008/3/23",  "y":"12.3"},
    {"ds":"2008/3/24",  "y":"9.4"},
    {"ds":"2008/3/25",  "y":"12.5"},
    {"ds":"2008/3/26",  "y":"14.4"},
    {"ds":"2008/3/27",  "y":"12"},
    {"ds":"2008/3/28",  "y":"12.6"},
    {"ds":"2008/3/29",  "y":"12.1"},
    {"ds":"2008/3/30",  "y":"8.9"},
    {"ds":"2008/3/31",  "y":"7.8"},
    {"ds":"2008/4/1",  "y":"11.2"},
    {"ds":"2008/4/2",  "y":"13"},
    {"ds":"2008/4/3",  "y":"13.6"},
    {"ds":"2008/4/4",  "y":"14.1"},
    {"ds":"2008/4/5",  "y":"14.6"},
    {"ds":"2008/4/6",  "y":"14.7"},
    {"ds":"2008/4/7",  "y":"13.3"},
    {"ds":"2008/4/8",  "y":"12.1"},
    {"ds":"2008/4/9",  "y":"13.1"},
    {"ds":"2008/4/10",  "y":"10.1"},
    {"ds":"2008/4/11",  "y":"14.3"},
    {"ds":"2008/4/12",  "y":"15.9"},
    {"ds":"2008/4/13",  "y":"10.1"},
    {"ds":"2008/4/14",  "y":"12.9"},
    {"ds":"2008/4/15",  "y":"16.2"},
    {"ds":"2008/4/16",  "y":"17.6"},
    {"ds":"2008/4/17",  "y":"16.6"},
    {"ds":"2008/4/18",  "y":"13.4"},
    {"ds":"2008/4/19",  "y":"14.5"},
    {"ds":"2008/4/20",  "y":"15.7"},
    {"ds":"2008/4/21",  "y":"15.8"},
    {"ds":"2008/4/22",  "y":"16"},
    {"ds":"2008/4/23",  "y":"17.2"},
    {"ds":"2008/4/24",  "y":"18.2"},
    {"ds":"2008/4/25",  "y":"14.8"},
    {"ds":"2008/4/26",  "y":"13.7"},
    {"ds":"2008/4/27",  "y":"14.5"},
    {"ds":"2008/4/28",  "y":"15.9"},
    {"ds":"2008/4/29",  "y":"17.6"},
    {"ds":"2008/4/30",  "y":"20.5"},
    {"ds":"2008/5/1",  "y":"20.8"},
    {"ds":"2008/5/2",  "y":"19.9"},
    {"ds":"2008/5/3",  "y":"18.8"},
    {"ds":"2008/5/4",  "y":"18.5"},
    {"ds":"2008/5/5",  "y":"18.6"},
    {"ds":"2008/5/6",  "y":"19.8"},
    {"ds":"2008/5/7",  "y":"21.5"},
    {"ds":"2008/5/8",  "y":"19.6"},
    {"ds":"2008/5/9",  "y":"18.9"},
    {"ds":"2008/5/10",  "y":"13.5"},
    {"ds":"2008/5/11",  "y":"11.7"},
    {"ds":"2008/5/12",  "y":"12.5"},
    {"ds":"2008/5/13",  "y":"11.6"},
    {"ds":"2008/5/14",  "y":"12.9"},
    {"ds":"2008/5/15",  "y":"17.3"},
    {"ds":"2008/5/16",  "y":"18.7"},
    {"ds":"2008/5/17",  "y":"18.9"},
    {"ds":"2008/5/18",  "y":"18.6"},
    {"ds":"2008/5/19",  "y":"19.7"},
    {"ds":"2008/5/20",  "y":"20.4"},
    {"ds":"2008/5/21",  "y":"20.1"},
    {"ds":"2008/5/22",  "y":"21.7"},
    {"ds":"2008/5/23",  "y":"24.3"},
    {"ds":"2008/5/24",  "y":"21.6"},
    {"ds":"2008/5/25",  "y":"20.8"},
    {"ds":"2008/5/26",  "y":"23.1"},
    {"ds":"2008/5/27",  "y":"22.8"},
    {"ds":"2008/5/28",  "y":"21.3"},
    {"ds":"2008/5/29",  "y":"15.8"},
    {"ds":"2008/5/30",  "y":"14.9"},
    {"ds":"2008/5/31",  "y":"13.5"},
    {"ds":"2008/6/1",  "y":"18.7"},
    {"ds":"2008/6/2",  "y":"19.2"},
    {"ds":"2008/6/3",  "y":"15.8"},
    {"ds":"2008/6/4",  "y":"18.3"},
    {"ds":"2008/6/5",  "y":"18.6"},
    {"ds":"2008/6/6",  "y":"22.8"},
    {"ds":"2008/6/7",  "y":"23"},
    {"ds":"2008/6/8",  "y":"21.7"},
    {"ds":"2008/6/9",  "y":"21.2"},
    {"ds":"2008/6/10",  "y":"22.3"},
    {"ds":"2008/6/11",  "y":"22.8"},
    {"ds":"2008/6/12",  "y":"18.6"},
    {"ds":"2008/6/13",  "y":"21.7"},
    {"ds":"2008/6/14",  "y":"23.1"},
    {"ds":"2008/6/15",  "y":"21.1"},
    {"ds":"2008/6/16",  "y":"22.9"},
    {"ds":"2008/6/17",  "y":"22.1"},
    {"ds":"2008/6/18",  "y":"22.2"},
    {"ds":"2008/6/19",  "y":"23.7"},
    {"ds":"2008/6/20",  "y":"22.9"},
    {"ds":"2008/6/21",  "y":"23.5"},
    {"ds":"2008/6/22",  "y":"21"},
    {"ds":"2008/6/23",  "y":"21.1"},
    {"ds":"2008/6/24",  "y":"23.6"},
    {"ds":"2008/6/25",  "y":"21.6"},
    {"ds":"2008/6/26",  "y":"17"},
    {"ds":"2008/6/27",  "y":"21.6"},
    {"ds":"2008/6/28",  "y":"23.4"},
    {"ds":"2008/6/29",  "y":"21"},
    {"ds":"2008/6/30",  "y":"21.7"},
    {"ds":"2008/7/1",  "y":"21.8"},
    {"ds":"2008/7/2",  "y":"23.7"},
    {"ds":"2008/7/3",  "y":"24.3"},
    {"ds":"2008/7/4",  "y":"26.5"},
    {"ds":"2008/7/5",  "y":"27.5"},
    {"ds":"2008/7/6",  "y":"27"},
    {"ds":"2008/7/7",  "y":"25.1"},
    {"ds":"2008/7/8",  "y":"24.1"},
    {"ds":"2008/7/9",  "y":"24.3"},
    {"ds":"2008/7/10",  "y":"24.6"},
    {"ds":"2008/7/11",  "y":"26"},
    {"ds":"2008/7/12",  "y":"28"},
    {"ds":"2008/7/13",  "y":"28.5"},
    {"ds":"2008/7/14",  "y":"28.9"},
    {"ds":"2008/7/15",  "y":"27.8"},
    {"ds":"2008/7/16",  "y":"27.3"},
    {"ds":"2008/7/17",  "y":"27.9"},
    {"ds":"2008/7/18",  "y":"28.7"},
    {"ds":"2008/7/19",  "y":"29.1"},
    {"ds":"2008/7/20",  "y":"27"},
    {"ds":"2008/7/21",  "y":"27"},
    {"ds":"2008/7/22",  "y":"28.4"},
    {"ds":"2008/7/23",  "y":"28.9"},
    {"ds":"2008/7/24",  "y":"29.1"},
    {"ds":"2008/7/25",  "y":"29.4"},
    {"ds":"2008/7/26",  "y":"27.9"},
    {"ds":"2008/7/27",  "y":"27.6"},
    {"ds":"2008/7/28",  "y":"29.3"},
    {"ds":"2008/7/29",  "y":"28.5"},
    {"ds":"2008/7/30",  "y":"26.4"},
    {"ds":"2008/7/31",  "y":"26.2"},
    {"ds":"2008/8/1",  "y":"27.4"},
    {"ds":"2008/8/2",  "y":"28.3"},
    {"ds":"2008/8/3",  "y":"29.4"},
    {"ds":"2008/8/4",  "y":"30.2"},
    {"ds":"2008/8/5",  "y":"27.6"},
    {"ds":"2008/8/6",  "y":"29.8"},
    {"ds":"2008/8/7",  "y":"30.2"},
    {"ds":"2008/8/8",  "y":"30.7"},
    {"ds":"2008/8/9",  "y":"29.2"},
    {"ds":"2008/8/10",  "y":"26.6"},
    {"ds":"2008/8/11",  "y":"28.1"},
    {"ds":"2008/8/12",  "y":"28.7"},
    {"ds":"2008/8/13",  "y":"29.2"},
    {"ds":"2008/8/14",  "y":"30.1"},
    {"ds":"2008/8/15",  "y":"30.7"},
    {"ds":"2008/8/16",  "y":"28.7"},
    {"ds":"2008/8/17",  "y":"22.6"},
    {"ds":"2008/8/18",  "y":"25.2"},
    {"ds":"2008/8/19",  "y":"28.5"},
    {"ds":"2008/8/20",  "y":"27.7"},
    {"ds":"2008/8/21",  "y":"25.4"},
    {"ds":"2008/8/22",  "y":"22.4"},
    {"ds":"2008/8/23",  "y":"20.9"},
    {"ds":"2008/8/24",  "y":"21.6"},
    {"ds":"2008/8/25",  "y":"23.2"},
    {"ds":"2008/8/26",  "y":"22.1"},
    {"ds":"2008/8/27",  "y":"24.6"},
    {"ds":"2008/8/28",  "y":"25.5"},
    {"ds":"2008/8/29",  "y":"25.9"},
    {"ds":"2008/8/30",  "y":"24.8"},
    {"ds":"2008/8/31",  "y":"25.6"},
    {"ds":"2008/9/1",  "y":"27.3"},
    {"ds":"2008/9/2",  "y":"28.3"},
    {"ds":"2008/9/3",  "y":"28.7"},
    {"ds":"2008/9/4",  "y":"27.4"},
    {"ds":"2008/9/5",  "y":"26.6"},
    {"ds":"2008/9/6",  "y":"27"},
    {"ds":"2008/9/7",  "y":"26.7"},
    {"ds":"2008/9/8",  "y":"27.1"},
    {"ds":"2008/9/9",  "y":"25.6"},
    {"ds":"2008/9/10",  "y":"24.2"},
    {"ds":"2008/9/11",  "y":"23.2"},
    {"ds":"2008/9/12",  "y":"26.4"},
    {"ds":"2008/9/13",  "y":"27"},
    {"ds":"2008/9/14",  "y":"25.6"},
    {"ds":"2008/9/15",  "y":"24.4"},
    {"ds":"2008/9/16",  "y":"23.3"},
    {"ds":"2008/9/17",  "y":"25.2"},
    {"ds":"2008/9/18",  "y":"24.1"},
    {"ds":"2008/9/19",  "y":"23.9"},
    {"ds":"2008/9/20",  "y":"24.5"},
    {"ds":"2008/9/21",  "y":"23"},
    {"ds":"2008/9/22",  "y":"20.9"},
    {"ds":"2008/9/23",  "y":"23.6"},
    {"ds":"2008/9/24",  "y":"24.7"},
    {"ds":"2008/9/25",  "y":"24.9"},
    {"ds":"2008/9/26",  "y":"26"},
    {"ds":"2008/9/27",  "y":"20.1"},
    {"ds":"2008/9/28",  "y":"18.1"},
    {"ds":"2008/9/29",  "y":"16.6"},
    {"ds":"2008/9/30",  "y":"17.2"},
    {"ds":"2008/10/1",  "y":"18.9"},
    {"ds":"2008/10/2",  "y":"19.6"},
    {"ds":"2008/10/3",  "y":"20"},
    {"ds":"2008/10/4",  "y":"20.6"},
    {"ds":"2008/10/5",  "y":"21"},
    {"ds":"2008/10/6",  "y":"18.3"},
    {"ds":"2008/10/7",  "y":"21.6"},
    {"ds":"2008/10/8",  "y":"19"},
    {"ds":"2008/10/9",  "y":"21.1"},
    {"ds":"2008/10/10",  "y":"21.7"},
    {"ds":"2008/10/11",  "y":"20.8"},
    {"ds":"2008/10/12",  "y":"18.6"},
    {"ds":"2008/10/13",  "y":"19.5"},
    {"ds":"2008/10/14",  "y":"18.6"},
    {"ds":"2008/10/15",  "y":"19.9"},
    {"ds":"2008/10/16",  "y":"19.7"},
    {"ds":"2008/10/17",  "y":"19.6"},
    {"ds":"2008/10/18",  "y":"19.6"},
    {"ds":"2008/10/19",  "y":"19.4"},
    {"ds":"2008/10/20",  "y":"20"},
    {"ds":"2008/10/21",  "y":"20.2"},
    {"ds":"2008/10/22",  "y":"19.8"},
    {"ds":"2008/10/23",  "y":"20.3"},
    {"ds":"2008/10/24",  "y":"21"},
    {"ds":"2008/10/25",  "y":"20.6"},
    {"ds":"2008/10/26",  "y":"19.3"},
    {"ds":"2008/10/27",  "y":"18"},
    {"ds":"2008/10/28",  "y":"17.1"},
    {"ds":"2008/10/29",  "y":"17"},
    {"ds":"2008/10/30",  "y":"14.8"},
    {"ds":"2008/10/31",  "y":"14.4"},
    {"ds":"2008/11/1",  "y":"16.1"},
    {"ds":"2008/11/2",  "y":"14.9"},
    {"ds":"2008/11/3",  "y":"15.7"},
    {"ds":"2008/11/4",  "y":"16.3"},
    {"ds":"2008/11/5",  "y":"14.4"},
    {"ds":"2008/11/6",  "y":"15.8"},
    {"ds":"2008/11/7",  "y":"17.3"},
    {"ds":"2008/11/8",  "y":"13.9"},
    {"ds":"2008/11/9",  "y":"11.4"},
    {"ds":"2008/11/10",  "y":"11.9"},
    {"ds":"2008/11/11",  "y":"11.6"},
    {"ds":"2008/11/12",  "y":"12.2"},
    {"ds":"2008/11/13",  "y":"14.9"},
    {"ds":"2008/11/14",  "y":"15.1"},
    {"ds":"2008/11/15",  "y":"16.2"},
    {"ds":"2008/11/16",  "y":"15.3"},
    {"ds":"2008/11/17",  "y":"15.8"},
    {"ds":"2008/11/18",  "y":"15.7"},
    {"ds":"2008/11/19",  "y":"11.3"},
    {"ds":"2008/11/20",  "y":"9.4"},
    {"ds":"2008/11/21",  "y":"11"},
    {"ds":"2008/11/22",  "y":"11.1"},
    {"ds":"2008/11/23",  "y":"12.1"},
    {"ds":"2008/11/24",  "y":"9.4"},
    {"ds":"2008/11/25",  "y":"9.5"},
    {"ds":"2008/11/26",  "y":"11"},
    {"ds":"2008/11/27",  "y":"8.8"},
    {"ds":"2008/11/28",  "y":"10.6"},
    {"ds":"2008/11/29",  "y":"13.1"},
    {"ds":"2008/11/30",  "y":"12"},
    {"ds":"2008/12/1",  "y":"9.9"},
    {"ds":"2008/12/2",  "y":"9.3"},
    {"ds":"2008/12/3",  "y":"12.3"},
    {"ds":"2008/12/4",  "y":"12.4"},
    {"ds":"2008/12/5",  "y":"14.2"},
    {"ds":"2008/12/6",  "y":"10.3"},
    {"ds":"2008/12/7",  "y":"7.5"},
    {"ds":"2008/12/8",  "y":"8.1"},
    {"ds":"2008/12/9",  "y":"8.8"},
    {"ds":"2008/12/10",  "y":"14.1"},
    {"ds":"2008/12/11",  "y":"14"},
    {"ds":"2008/12/12",  "y":"13.1"},
    {"ds":"2008/12/13",  "y":"11.3"},
    {"ds":"2008/12/14",  "y":"7.5"},
    {"ds":"2008/12/15",  "y":"7.2"},
    {"ds":"2008/12/16",  "y":"8.4"},
    {"ds":"2008/12/17",  "y":"8.8"},
    {"ds":"2008/12/18",  "y":"11.4"},
    {"ds":"2008/12/19",  "y":"10"},
    {"ds":"2008/12/20",  "y":"10.1"},
    {"ds":"2008/12/21",  "y":"13.5"},
    {"ds":"2008/12/22",  "y":"13.2"},
    {"ds":"2008/12/23",  "y":"6.9"},
    {"ds":"2008/12/24",  "y":"6.8"},
    {"ds":"2008/12/25",  "y":"10.1"},
    {"ds":"2008/12/26",  "y":"5.2"},
    {"ds":"2008/12/27",  "y":"6"},
    {"ds":"2008/12/28",  "y":"7.3"},
    {"ds":"2008/12/29",  "y":"9.9"},
    {"ds":"2008/12/30",  "y":"9"},
    {"ds":"2008/12/31",  "y":"6.6"},
    {"ds":"2009/1/1",  "y":"6.2"},
    {"ds":"2009/1/2",  "y":"6.9"},
    {"ds":"2009/1/3",  "y":"6.6"},
    {"ds":"2009/1/4",  "y":"7.5"},
    {"ds":"2009/1/5",  "y":"8.5"},
    {"ds":"2009/1/6",  "y":"8.6"},
    {"ds":"2009/1/7",  "y":"7"},
    {"ds":"2009/1/8",  "y":"6.7"},
    {"ds":"2009/1/9",  "y":"4.4"},
    {"ds":"2009/1/10",  "y":"5.6"},
    {"ds":"2009/1/11",  "y":"5.1"},
    {"ds":"2009/1/12",  "y":"4.5"},
    {"ds":"2009/1/13",  "y":"5.1"},
    {"ds":"2009/1/14",  "y":"5.9"},
    {"ds":"2009/1/15",  "y":"4.3"},
    {"ds":"2009/1/16",  "y":"5"},
    {"ds":"2009/1/17",  "y":"6.4"},
    {"ds":"2009/1/18",  "y":"6"},
    {"ds":"2009/1/19",  "y":"9.1"},
    {"ds":"2009/1/20",  "y":"7.5"},
    {"ds":"2009/1/21",  "y":"6.6"},
    {"ds":"2009/1/22",  "y":"5.9"},
    {"ds":"2009/1/23",  "y":"10.3"},
    {"ds":"2009/1/24",  "y":"6.8"},
    {"ds":"2009/1/25",  "y":"5.9"},
    {"ds":"2009/1/26",  "y":"6.5"},
    {"ds":"2009/1/27",  "y":"7.6"},
    {"ds":"2009/1/28",  "y":"6.7"},
    {"ds":"2009/1/29",  "y":"8.9"},
    {"ds":"2009/1/30",  "y":"9.6"},
    {"ds":"2009/1/31",  "y":"7.8"},
    {"ds":"2009/2/1",  "y":"7.9"},
    {"ds":"2009/2/2",  "y":"6.2"},
    {"ds":"2009/2/3",  "y":"8.9"},
    {"ds":"2009/2/4",  "y":"7.5"},
    {"ds":"2009/2/5",  "y":"7.4"},
    {"ds":"2009/2/6",  "y":"7.9"},
    {"ds":"2009/2/7",  "y":"7.1"},
    {"ds":"2009/2/8",  "y":"7.4"},
    {"ds":"2009/2/9",  "y":"6.1"},
    {"ds":"2009/2/10",  "y":"8.7"},
    {"ds":"2009/2/11",  "y":"6.9"},
    {"ds":"2009/2/12",  "y":"9.8"},
    {"ds":"2009/2/13",  "y":"11.4"},
    {"ds":"2009/2/14",  "y":"18.1"},
    {"ds":"2009/2/15",  "y":"12.7"},
    {"ds":"2009/2/16",  "y":"10.5"},
    {"ds":"2009/2/17",  "y":"4.9"},
    {"ds":"2009/2/18",  "y":"6.1"},
    {"ds":"2009/2/19",  "y":"6.6"},
    {"ds":"2009/2/20",  "y":"6.3"},
    {"ds":"2009/2/21",  "y":"6.4"},
    {"ds":"2009/2/22",  "y":"7.7"},
    {"ds":"2009/2/23",  "y":"6.6"},
    {"ds":"2009/2/24",  "y":"5.2"},
    {"ds":"2009/2/25",  "y":"7.6"},
    {"ds":"2009/2/26",  "y":"6.9"},
    {"ds":"2009/2/27",  "y":"3.4"},
    {"ds":"2009/2/28",  "y":"6.8"},
    {"ds":"2009/3/1",  "y":"7.1"},
    {"ds":"2009/3/2",  "y":"6.9"},
    {"ds":"2009/3/3",  "y":"3.2"},
    {"ds":"2009/3/4",  "y":"5.8"},
    {"ds":"2009/3/5",  "y":"8.6"},
    {"ds":"2009/3/6",  "y":"8.1"},
    {"ds":"2009/3/7",  "y":"11.6"},
    {"ds":"2009/3/8",  "y":"8.6"},
    {"ds":"2009/3/9",  "y":"10.2"},
    {"ds":"2009/3/10",  "y":"11.5"},
    {"ds":"2009/3/11",  "y":"7.6"},
    {"ds":"2009/3/12",  "y":"8.1"},
    {"ds":"2009/3/13",  "y":"10"},
    {"ds":"2009/3/14",  "y":"11.6"},
    {"ds":"2009/3/15",  "y":"9.4"},
    {"ds":"2009/3/16",  "y":"11.1"},
    {"ds":"2009/3/17",  "y":"14.4"},
    {"ds":"2009/3/18",  "y":"15.1"},
    {"ds":"2009/3/19",  "y":"17.2"},
    {"ds":"2009/3/20",  "y":"15.3"},
    {"ds":"2009/3/21",  "y":"11.8"},
    {"ds":"2009/3/22",  "y":"15.3"},
    {"ds":"2009/3/23",  "y":"12.7"},
    {"ds":"2009/3/24",  "y":"8.6"},
    {"ds":"2009/3/25",  "y":"8"},
    {"ds":"2009/3/26",  "y":"8"},
    {"ds":"2009/3/27",  "y":"7.8"},
    {"ds":"2009/3/28",  "y":"7.8"},
    {"ds":"2009/3/29",  "y":"8.1"},
    {"ds":"2009/3/30",  "y":"8.7"},
    {"ds":"2009/3/31",  "y":"10.7"},
    {"ds":"2009/4/1",  "y":"9.9"},
    {"ds":"2009/4/2",  "y":"9.8"},
    {"ds":"2009/4/3",  "y":"12.3"},
    {"ds":"2009/4/4",  "y":"13.8"},
    {"ds":"2009/4/5",  "y":"14.5"},
    {"ds":"2009/4/6",  "y":"14.9"},
    {"ds":"2009/4/7",  "y":"16"},
    {"ds":"2009/4/8",  "y":"16.2"},
    {"ds":"2009/4/9",  "y":"18.3"},
    {"ds":"2009/4/10",  "y":"18.6"},
    {"ds":"2009/4/11",  "y":"18.1"},
    {"ds":"2009/4/12",  "y":"16.3"},
    {"ds":"2009/4/13",  "y":"18.8"},
    {"ds":"2009/4/14",  "y":"17.9"},
    {"ds":"2009/4/15",  "y":"19.7"},
    {"ds":"2009/4/16",  "y":"17.7"},
    {"ds":"2009/4/17",  "y":"12.7"},
    {"ds":"2009/4/18",  "y":"15.2"},
    {"ds":"2009/4/19",  "y":"17.4"},
    {"ds":"2009/4/20",  "y":"16.8"},
    {"ds":"2009/4/21",  "y":"18.1"},
    {"ds":"2009/4/22",  "y":"19.7"},
    {"ds":"2009/4/23",  "y":"17.1"},
    {"ds":"2009/4/24",  "y":"13.3"},
    {"ds":"2009/4/25",  "y":"11.2"},
    {"ds":"2009/4/26",  "y":"16.8"},
    {"ds":"2009/4/27",  "y":"14.4"},
    {"ds":"2009/4/28",  "y":"13"},
    {"ds":"2009/4/29",  "y":"15.5"},
    {"ds":"2009/4/30",  "y":"17.8"},
    {"ds":"2009/5/1",  "y":"19.5"},
    {"ds":"2009/5/2",  "y":"19.8"},
    {"ds":"2009/5/3",  "y":"20"},
    {"ds":"2009/5/4",  "y":"20.4"},
    {"ds":"2009/5/5",  "y":"17.8"},
    {"ds":"2009/5/6",  "y":"16.4"},
    {"ds":"2009/5/7",  "y":"17"},
    {"ds":"2009/5/8",  "y":"17.8"},
    {"ds":"2009/5/9",  "y":"21"},
    {"ds":"2009/5/10",  "y":"23"},
    {"ds":"2009/5/11",  "y":"21.4"},
    {"ds":"2009/5/12",  "y":"22.2"},
    {"ds":"2009/5/13",  "y":"22.4"},
    {"ds":"2009/5/14",  "y":"18.4"},
    {"ds":"2009/5/15",  "y":"16.3"},
    {"ds":"2009/5/16",  "y":"17.6"},
    {"ds":"2009/5/17",  "y":"19.4"},
    {"ds":"2009/5/18",  "y":"23.7"},
    {"ds":"2009/5/19",  "y":"21.7"},
    {"ds":"2009/5/20",  "y":"23.2"},
    {"ds":"2009/5/21",  "y":"23"},
    {"ds":"2009/5/22",  "y":"21.8"},
    {"ds":"2009/5/23",  "y":"23.2"},
    {"ds":"2009/5/24",  "y":"19.4"},
    {"ds":"2009/5/25",  "y":"18.9"},
    {"ds":"2009/5/26",  "y":"21.3"},
    {"ds":"2009/5/27",  "y":"21.5"},
    {"ds":"2009/5/28",  "y":"18.5"},
    {"ds":"2009/5/29",  "y":"17.5"},
    {"ds":"2009/5/30",  "y":"18.4"},
    {"ds":"2009/5/31",  "y":"19.7"},
    {"ds":"2009/6/1",  "y":"19"},
    {"ds":"2009/6/2",  "y":"21.1"},
    {"ds":"2009/6/3",  "y":"21.9"},
    {"ds":"2009/6/4",  "y":"21.6"},
    {"ds":"2009/6/5",  "y":"20"},
    {"ds":"2009/6/6",  "y":"20.5"},
    {"ds":"2009/6/7",  "y":"22.8"},
    {"ds":"2009/6/8",  "y":"19"},
    {"ds":"2009/6/9",  "y":"21.8"},
    {"ds":"2009/6/10",  "y":"23.1"},
    {"ds":"2009/6/11",  "y":"21.6"},
    {"ds":"2009/6/12",  "y":"23.6"},
    {"ds":"2009/6/13",  "y":"23"},
    {"ds":"2009/6/14",  "y":"20.7"},
    {"ds":"2009/6/15",  "y":"20.8"},
    {"ds":"2009/6/16",  "y":"19.6"},
    {"ds":"2009/6/17",  "y":"21.2"},
    {"ds":"2009/6/18",  "y":"21.7"},
    {"ds":"2009/6/19",  "y":"22.3"},
    {"ds":"2009/6/20",  "y":"23.2"},
    {"ds":"2009/6/21",  "y":"22.8"},
    {"ds":"2009/6/22",  "y":"23.8"},
    {"ds":"2009/6/23",  "y":"26.5"},
    {"ds":"2009/6/24",  "y":"24.1"},
    {"ds":"2009/6/25",  "y":"24.9"},
    {"ds":"2009/6/26",  "y":"26.8"},
    {"ds":"2009/6/27",  "y":"26.6"},
    {"ds":"2009/6/28",  "y":"23.5"},
    {"ds":"2009/6/29",  "y":"25.3"},
    {"ds":"2009/6/30",  "y":"22.8"},
    {"ds":"2009/7/1",  "y":"23.3"},
    {"ds":"2009/7/2",  "y":"21.2"},
    {"ds":"2009/7/3",  "y":"23.2"},
    {"ds":"2009/7/4",  "y":"24"},
    {"ds":"2009/7/5",  "y":"23.8"},
    {"ds":"2009/7/6",  "y":"23.7"},
    {"ds":"2009/7/7",  "y":"26.9"},
    {"ds":"2009/7/8",  "y":"26.5"},
    {"ds":"2009/7/9",  "y":"27.9"},
    {"ds":"2009/7/10",  "y":"28.3"},
    {"ds":"2009/7/11",  "y":"25.3"},
    {"ds":"2009/7/12",  "y":"25.5"},
    {"ds":"2009/7/13",  "y":"28.9"},
    {"ds":"2009/7/14",  "y":"27.6"},
    {"ds":"2009/7/15",  "y":"29.1"},
    {"ds":"2009/7/16",  "y":"29.3"},
    {"ds":"2009/7/17",  "y":"25.9"},
    {"ds":"2009/7/18",  "y":"27.7"},
    {"ds":"2009/7/19",  "y":"29.4"},
    {"ds":"2009/7/20",  "y":"27.1"},
    {"ds":"2009/7/21",  "y":"22.8"},
    {"ds":"2009/7/22",  "y":"24.1"},
    {"ds":"2009/7/23",  "y":"25.6"},
    {"ds":"2009/7/24",  "y":"26.3"},
    {"ds":"2009/7/25",  "y":"28.1"},
    {"ds":"2009/7/26",  "y":"29.6"},
    {"ds":"2009/7/27",  "y":"27.2"},
    {"ds":"2009/7/28",  "y":"26.7"},
    {"ds":"2009/7/29",  "y":"28.2"},
    {"ds":"2009/7/30",  "y":"28.4"},
    {"ds":"2009/7/31",  "y":"23.3"},
    {"ds":"2009/8/1",  "y":"24.6"},
    {"ds":"2009/8/2",  "y":"24.3"},
    {"ds":"2009/8/3",  "y":"26.3"},
    {"ds":"2009/8/4",  "y":"26"},
    {"ds":"2009/8/5",  "y":"27.5"},
    {"ds":"2009/8/6",  "y":"27.5"},
    {"ds":"2009/8/7",  "y":"28.6"},
    {"ds":"2009/8/8",  "y":"27.6"},
    {"ds":"2009/8/9",  "y":"28.3"},
    {"ds":"2009/8/10",  "y":"27.1"},
    {"ds":"2009/8/11",  "y":"26.7"},
    {"ds":"2009/8/12",  "y":"26.6"},
    {"ds":"2009/8/13",  "y":"28.2"},
    {"ds":"2009/8/14",  "y":"28.6"},
    {"ds":"2009/8/15",  "y":"27.2"},
    {"ds":"2009/8/16",  "y":"27.8"},
    {"ds":"2009/8/17",  "y":"26.5"},
    {"ds":"2009/8/18",  "y":"26.6"},
    {"ds":"2009/8/19",  "y":"27.3"},
    {"ds":"2009/8/20",  "y":"27.6"},
    {"ds":"2009/8/21",  "y":"28.9"},
    {"ds":"2009/8/22",  "y":"28.9"},
    {"ds":"2009/8/23",  "y":"27.2"},
    {"ds":"2009/8/24",  "y":"26"},
    {"ds":"2009/8/25",  "y":"24.8"},
    {"ds":"2009/8/26",  "y":"24.4"},
    {"ds":"2009/8/27",  "y":"25.3"},
    {"ds":"2009/8/28",  "y":"27.4"},
    {"ds":"2009/8/29",  "y":"28.6"},
    {"ds":"2009/8/30",  "y":"23.3"},
    {"ds":"2009/8/31",  "y":"19.1"},
    {"ds":"2009/9/1",  "y":"25.7"},
    {"ds":"2009/9/2",  "y":"22.3"},
    {"ds":"2009/9/3",  "y":"22.2"},
    {"ds":"2009/9/4",  "y":"23.2"},
    {"ds":"2009/9/5",  "y":"24.4"},
    {"ds":"2009/9/6",  "y":"24.4"},
    {"ds":"2009/9/7",  "y":"24.9"},
    {"ds":"2009/9/8",  "y":"24.8"},
    {"ds":"2009/9/9",  "y":"22.6"},
    {"ds":"2009/9/10",  "y":"24.1"},
    {"ds":"2009/9/11",  "y":"23.9"},
    {"ds":"2009/9/12",  "y":"21.4"},
    {"ds":"2009/9/13",  "y":"23.7"},
    {"ds":"2009/9/14",  "y":"23.2"},
    {"ds":"2009/9/15",  "y":"21.9"},
    {"ds":"2009/9/16",  "y":"23.7"},
    {"ds":"2009/9/17",  "y":"22.5"},
    {"ds":"2009/9/18",  "y":"20.9"},
    {"ds":"2009/9/19",  "y":"21.7"},
    {"ds":"2009/9/20",  "y":"22.4"},
    {"ds":"2009/9/21",  "y":"21.3"},
    {"ds":"2009/9/22",  "y":"23.3"},
    {"ds":"2009/9/23",  "y":"23.9"},
    {"ds":"2009/9/24",  "y":"23.3"},
    {"ds":"2009/9/25",  "y":"23.3"},
    {"ds":"2009/9/26",  "y":"23.4"},
    {"ds":"2009/9/27",  "y":"21.9"},
    {"ds":"2009/9/28",  "y":"23.4"},
    {"ds":"2009/9/29",  "y":"23.1"},
    {"ds":"2009/9/30",  "y":"20.2"},
    {"ds":"2009/10/1",  "y":"20.8"},
    {"ds":"2009/10/2",  "y":"21.3"},
    {"ds":"2009/10/3",  "y":"22.8"},
    {"ds":"2009/10/4",  "y":"22.4"},
    {"ds":"2009/10/5",  "y":"19.6"},
    {"ds":"2009/10/6",  "y":"17.8"},
    {"ds":"2009/10/7",  "y":"17.6"},
    {"ds":"2009/10/8",  "y":"21.2"},
    {"ds":"2009/10/9",  "y":"20.4"},
    {"ds":"2009/10/10",  "y":"17.7"},
    {"ds":"2009/10/11",  "y":"18.9"},
    {"ds":"2009/10/12",  "y":"18.5"},
    {"ds":"2009/10/13",  "y":"19.8"},
    {"ds":"2009/10/14",  "y":"18.2"},
    {"ds":"2009/10/15",  "y":"18.1"},
    {"ds":"2009/10/16",  "y":"18.6"},
    {"ds":"2009/10/17",  "y":"18.4"},
    {"ds":"2009/10/18",  "y":"19.7"},
    {"ds":"2009/10/19",  "y":"19.7"},
    {"ds":"2009/10/20",  "y":"21.9"},
    {"ds":"2009/10/21",  "y":"19.3"},
    {"ds":"2009/10/22",  "y":"18.5"},
    {"ds":"2009/10/23",  "y":"17.7"},
    {"ds":"2009/10/24",  "y":"16.1"},
    {"ds":"2009/10/25",  "y":"14.8"},
    {"ds":"2009/10/26",  "y":"14.4"},
    {"ds":"2009/10/27",  "y":"19.1"},
    {"ds":"2009/10/28",  "y":"18.4"},
    {"ds":"2009/10/29",  "y":"17.8"},
    {"ds":"2009/10/30",  "y":"19.9"},
    {"ds":"2009/10/31",  "y":"18.2"},
    {"ds":"2009/11/1",  "y":"19.6"},
    {"ds":"2009/11/2",  "y":"12.9"},
    {"ds":"2009/11/3",  "y":"10.2"},
    {"ds":"2009/11/4",  "y":"11.9"},
    {"ds":"2009/11/5",  "y":"13.5"},
    {"ds":"2009/11/6",  "y":"15.4"},
    {"ds":"2009/11/7",  "y":"16.5"},
    {"ds":"2009/11/8",  "y":"16.9"},
    {"ds":"2009/11/9",  "y":"17.8"},
    {"ds":"2009/11/10",  "y":"18.7"},
    {"ds":"2009/11/11",  "y":"17.3"},
    {"ds":"2009/11/12",  "y":"13.2"},
    {"ds":"2009/11/13",  "y":"11.2"},
    {"ds":"2009/11/14",  "y":"16.9"},
    {"ds":"2009/11/15",  "y":"16.9"},
    {"ds":"2009/11/16",  "y":"14.4"},
    {"ds":"2009/11/17",  "y":"10.3"},
    {"ds":"2009/11/18",  "y":"11.5"},
    {"ds":"2009/11/19",  "y":"8.2"},
    {"ds":"2009/11/20",  "y":"10.5"},
    {"ds":"2009/11/21",  "y":"12.2"},
    {"ds":"2009/11/22",  "y":"8.4"},
    {"ds":"2009/11/23",  "y":"11.2"},
    {"ds":"2009/11/24",  "y":"11.8"},
    {"ds":"2009/11/25",  "y":"13.4"},
    {"ds":"2009/11/26",  "y":"14.6"},
    {"ds":"2009/11/27",  "y":"14.1"},
    {"ds":"2009/11/28",  "y":"13.8"},
    {"ds":"2009/11/29",  "y":"10.6"},
    {"ds":"2009/11/30",  "y":"9.6"},
    {"ds":"2009/12/1",  "y":"11.5"},
    {"ds":"2009/12/2",  "y":"12"},
    {"ds":"2009/12/3",  "y":"10.1"},
    {"ds":"2009/12/4",  "y":"11.7"},
    {"ds":"2009/12/5",  "y":"10.3"},
    {"ds":"2009/12/6",  "y":"11.2"},
    {"ds":"2009/12/7",  "y":"10.3"},
    {"ds":"2009/12/8",  "y":"10.1"},
    {"ds":"2009/12/9",  "y":"10.2"},
    {"ds":"2009/12/10",  "y":"11"},
    {"ds":"2009/12/11",  "y":"8.1"},
    {"ds":"2009/12/12",  "y":"13"},
    {"ds":"2009/12/13",  "y":"11.2"},
    {"ds":"2009/12/14",  "y":"8.9"},
    {"ds":"2009/12/15",  "y":"7.9"},
    {"ds":"2009/12/16",  "y":"6.9"},
    {"ds":"2009/12/17",  "y":"7"},
    {"ds":"2009/12/18",  "y":"6.2"},
    {"ds":"2009/12/19",  "y":"5.2"},
    {"ds":"2009/12/20",  "y":"6.3"},
    {"ds":"2009/12/21",  "y":"5.9"},
    {"ds":"2009/12/22",  "y":"6.4"},
    {"ds":"2009/12/23",  "y":"7.7"},
    {"ds":"2009/12/24",  "y":"9.9"},
    {"ds":"2009/12/25",  "y":"9.2"},
    {"ds":"2009/12/26",  "y":"9.4"},
    {"ds":"2009/12/27",  "y":"9.4"},
    {"ds":"2009/12/28",  "y":"9.4"},
    {"ds":"2009/12/29",  "y":"8.1"},
    {"ds":"2009/12/30",  "y":"9.2"},
    {"ds":"2009/12/31",  "y":"6.2"},];
console.log("go fit");
test.fit(f_df);